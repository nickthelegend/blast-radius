import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allExposures,
  blastRadius,
  blastRadiusForRepos,
  buildVersionTimeline,
  clearCompromised,
  exposureAsOf,
  findPackage,
  findScenario,
  findVersion,
  graphStats,
  listCompromisedVersions,
  listRepos,
  ablateEdgeTypes,
  advisoryRadius,
  boltQuery,
  calibrateBudget,
  compareConsistency,
  lockfileDrift,
  resolveRepoKeys,
  suggestVersions,
  listVersionsOfPackage,
  maintainerWeb,
  markCompromised,
  planRemediation,
  preflight,
  prioritiseExposure,
  advisories as advisoriesQuery,
  explainPath,
  maintainerBlastRadius,
  readSnapshot,
  snapshotExists,
  SCENARIOS,
  simulate,
  timeMachine,
  typosquats,
  type GraphPath,
} from '@blast/core';
import express, { type Request, type Response } from 'express';

import { createContext } from '../context.js';
import { Admission, EpochCache } from '../serve/admission.js';
import { bold, cyan, dim } from '../format.js';

/** Small helper so every handler reports errors the same way. */
const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response): void => {
    fn(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) res.status(400).json({ error: message });
      else res.end();
    });
  };

export async function serveCommand(options: { port?: string; open?: boolean }): Promise<void> {
  const { config, client } = createContext();
  const app = express();
  app.use(express.json());

  const port = options.port ? Number(options.port) : config.server.apiPort;

  const traversal = () => ({
    maxDepth: config.traversal.maxDepth,
    pathCount: config.traversal.pathCount,
    resultLimit: config.traversal.resultLimit,
  });

  // Admission control. The cap is deliberately small: the engine serves this
  // graph in hundreds of milliseconds when it is not contended, and queueing in
  // the server keeps that true instead of letting every caller degrade together.
  const admission = new Admission(Number(process.env.BLAST_MAX_CONCURRENT_QUERIES ?? 4));

  /** The uncached shape of `/api/stats`. */
  const buildStats = async () => {
    const [stats, compromised, repos] = await Promise.all([
      graphStats(client),
      listCompromisedVersions(client),
      listRepos(client, config.org.name),
    ]);
    // The dashboard needs to know which of these is *the* incident. After a
    // simulation, dozens of propagated versions are marked compromised, and most
    // of them are packages no lockfile pins — landing on one of those renders
    // every view empty. The recorded incident is the meaningful default, so it
    // is surfaced here and floated to the front of the list.
    const incident = snapshotExists(config.paths.snapshot)
      ? readSnapshot(config.paths.snapshot).incident
      : null;

    const ordered = incident
      ? [
          ...compromised.filter((version) => version.key === incident.version_key),
          ...compromised.filter((version) => version.key !== incident.version_key),
        ]
      : compromised;

    return {
      stats,
      compromised: ordered,
      incident,
      repos,
      org: config.org.name,
      simulatedNow: config.org.simulatedNow,
      traversal: {
        maxDepth: config.traversal.maxDepth,
        pathCount: config.traversal.pathCount,
      },
    };
  };

  // One indexed read to learn whether the graph has moved, standing in for four
  // full scans when it has not — and correct when another process is the writer.
  const statsCache = new EpochCache<Awaited<ReturnType<typeof buildStats>>>(async () => {
    const probe = await client.query('MATCH (v:Version) RETURN v.id AS id LIMIT 1');
    return probe.readEpoch ?? null;
  });

  /**
   * Read a required query parameter, or answer 400 naming it.
   *
   * Passing an empty string down produced errors like `version not found: ` and
   * `repo not found: acme-corp/`, which tell a caller nothing about what the
   * endpoint wanted. Returns null when it has already answered.
   */
  const required = (req: Request, res: Response, name: string): string | null => {
    const value = String(req.query[name] ?? '').trim();
    if (!value) {
      res.status(400).json({ error: `required query parameter: ${name}` });
      return null;
    }
    return value;
  };

  const consistencyFor = (req: Request) =>
    req.query.verified === 'true'
      ? config.traversal.verifiedConsistency
      : config.traversal.readConsistency;

  // --- metadata ------------------------------------------------------------

  app.get(
    '/api/health',
    handle(async (_req, res) => {
      const ready = await client.ready(config.hydra.adminUrl);
      res.json({ ready, hydra: config.hydra.httpUrl, org: config.org.name });
    }),
  );

  app.get(
    '/api/stats',
    handle(async (_req, res) => {
      // The most expensive read in the product — four edge-type counts, every
      // one of which the engine plans as a full scan — and the one every page
      // load issues. Coalesced so parallel tab loads share a round trip, and
      // held across requests only while the read epoch has not advanced.
      const payload = await admission.run('stats', () => statsCache.get(() => buildStats()));
      res.json(payload);
    }),
  );

  app.get(
    '/api/repos',
    handle(async (_req, res) => {
      res.json(await listRepos(client, config.org.name));
    }),
  );

  app.get(
    '/api/scenarios',
    handle(async (_req, res) => {
      res.json(
        SCENARIOS.map((scenario) => ({
          name: scenario.name,
          title: scenario.title,
          description: scenario.description,
          reference: scenario.reference,
          windowMinutes: scenario.windowMinutes,
          artifactCount: scenario.artifactCount,
          propagationTargets: scenario.propagationTargets,
          from: scenario.from(config.org.simulatedNow),
          to: scenario.to(config.org.simulatedNow),
        })),
      );
    }),
  );

  /** Prefix search over version keys, for the package picker. */
  app.get(
    '/api/search',
    handle(async (req, res) => {
      const query = String(req.query.q ?? '').trim();
      if (query.length < 2) {
        res.json([]);
        return;
      }
      // HydraDB's WHERE supports STARTS WITH, which is exactly a prefix search
      // — but package keys are ecosystem-qualified (`npm:express`) and people
      // type the bare name. There is no CONTAINS to fall back on, so both
      // prefixes are tried and merged; each is still an indexed prefix scan.
      const prefixes = [query];
      for (const ecosystem of ['npm:', 'pypi:']) {
        if (!query.startsWith(ecosystem)) prefixes.push(`${ecosystem}${query}`);
      }

      const results = await Promise.all(
        prefixes.map((prefix) =>
          client.query(
            'MATCH (p:Package) WHERE p.key STARTS WITH $prefix ' +
              'RETURN p.key AS key, p.name AS name, p.dependent_count AS dependent_count, ' +
              'p.downloads AS downloads ORDER BY dependent_count DESC LIMIT 25',
            { parameters: { prefix } },
          ),
        ),
      );

      const merged = new Map<string, Record<string, unknown>>();
      for (const result of results) {
        for (const record of result.records) {
          const key = String(record.key ?? '');
          if (key && !merged.has(key)) merged.set(key, record);
        }
      }
      res.json(
        [...merged.values()]
          .sort((a, b) => Number(b.dependent_count ?? 0) - Number(a.dependent_count ?? 0))
          .slice(0, 25),
      );
    }),
  );

  app.get(
    '/api/versions',
    handle(async (req, res) => {
      const packageKey = required(req, res, 'package');
      if (packageKey === null) return;
      const versions = await listVersionsOfPackage(client, packageKey);
      res.json({ versions, timeline: buildVersionTimeline(versions) });
    }),
  );

  // --- blast radius --------------------------------------------------------

  app.get(
    '/api/exposure',
    handle(async (req, res) => {
      const key = required(req, res, 'version');
      if (key === null) return;
      const version = await findVersion(client, key);
      if (!version) {
        // "Not found" alone makes the tool feel broken when the graph is fine
        // and the caller simply omitted the `npm:` prefix.
        res.status(404).json({
          error: `version not found: ${key}`,
          suggestions: await suggestVersions(client, key),
        });
        return;
      }

      const depth = req.query.depth ? Number(req.query.depth) : config.traversal.maxDepth;
      const repos = String(req.query.repos ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      const options = { ...traversal(), maxDepth: depth, consistency: consistencyFor(req) };

      if (repos.length === 0) {
        res.json(await blastRadius(client, version, options));
        return;
      }

      // `blastRadiusForRepos` indexes on repo *keys*. Passing the names through
      // raw matched nothing and returned a cheerful 200 with zero exposure —
      // silently under-reporting a blast radius, which is the single worst
      // failure this tool can have. Names and keys are both accepted, and an
      // unknown repo is an error rather than an empty result.
      const { resolved, missing } = await resolveRepoKeys(client, repos, config.org.name);
      if (missing.length > 0) {
        const available = (await listRepos(client, config.org.name)).map((repo) => repo.name);
        res.status(404).json({
          error: `unknown repo${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
          known: available,
        });
        return;
      }

      res.json(
        await blastRadiusForRepos(
          client,
          version,
          resolved.map((repo) => repo.key),
          { ...options, pairwise: req.query.pairwise === 'true' },
        ),
      );
    }),
  );

  /** Node/link payload for the force-directed graph view. */
  app.get(
    '/api/graph',
    handle(async (req, res) => {
      const key = required(req, res, 'version');
      if (key === null) return;
      const version = await findVersion(client, key);
      if (!version) {
        // "Not found" alone makes the tool feel broken when the graph is fine
        // and the caller simply omitted the `npm:` prefix.
        res.status(404).json({
          error: `version not found: ${key}`,
          suggestions: await suggestVersions(client, key),
        });
        return;
      }
      const depth = req.query.depth ? Number(req.query.depth) : config.traversal.maxDepth;
      const maxLen = depth + 2;
      const result = await client.query(
        `CALL algo.SSpaths({sourceNode: ${version.id}, ` +
          `relTypes: ['RESOLVED_TO', 'RESOLVED_DIRECT', 'HAS_SNAPSHOT'], relDirection: 'incoming', ` +
          `maxLen: ${maxLen}, pathCount: ${config.traversal.pathCount}, ` +
          `resultLimit: ${config.traversal.resultLimit}}) YIELD path RETURN path`,
        { consistency: consistencyFor(req) },
      );

      const nodes = new Map<number, Record<string, unknown>>();
      const links = new Map<string, Record<string, unknown>>();
      const nodeLimit = Number(req.query.limit ?? 900);

      for (const record of result.records) {
        const path = record.path as GraphPath | undefined;
        if (!path?.nodes) continue;
        if (nodes.size > nodeLimit) break;

        path.nodes.forEach((node, index) => {
          if (nodes.has(node.id)) return;
          const label = node.labels.includes('Repo')
            ? 'Repo'
            : node.labels.includes('LockfileSnapshot')
              ? 'LockfileSnapshot'
              : 'Version';
          nodes.set(node.id, {
            id: node.id,
            label,
            key: node.properties.key ?? '',
            name:
              label === 'Version'
                ? `${node.properties.package_name ?? ''}@${node.properties.version_string ?? ''}`
                : (node.properties.name ?? node.properties.key ?? ''),
            depth: index,
            isCurrent: node.properties.is_current === true,
            isCompromised: node.properties.is_compromised === true,
            capturedAt: node.properties.captured_at ?? 0,
          });
        });

        for (const relationship of path.relationships) {
          const id = `${relationship.src}->${relationship.dst}:${relationship.type}`;
          if (links.has(id)) continue;
          links.set(id, {
            source: relationship.src,
            target: relationship.dst,
            type: relationship.type,
          });
        }
      }

      res.json({
        source: version,
        nodes: [...nodes.values()],
        links: [...links.values()].filter(
          (link) => nodes.has(link.source as number) && nodes.has(link.target as number),
        ),
        elapsedMs: result.elapsedMs,
        truncated: nodes.size > nodeLimit,
      });
    }),
  );

  // --- time machine --------------------------------------------------------

  app.get(
    '/api/time-machine',
    handle(async (req, res) => {
      const key = required(req, res, 'version');
      if (key === null) return;
      const version = await findVersion(client, key);
      if (!version) {
        // "Not found" alone makes the tool feel broken when the graph is fine
        // and the caller simply omitted the `npm:` prefix.
        res.status(404).json({
          error: `version not found: ${key}`,
          suggestions: await suggestVersions(client, key),
        });
        return;
      }
      const from = req.query.from ? Number(req.query.from) : undefined;
      const to = req.query.to ? Number(req.query.to) : undefined;
      const verified = req.query.verified === 'true';

      const [report, live, everything] = await Promise.all([
        timeMachine(client, version, { from, to, verified }),
        blastRadius(client, version, { ...traversal() }),
        allExposures(client, version),
      ]);

      res.json({
        timeMachine: report,
        exposedNow: live.exposedRepos,
        historical: live.historicallyExposedRepos,
        allExposures: everything,
      });
    }),
  );

  app.get(
    '/api/time-machine/as-of',
    handle(async (req, res) => {
      const key = required(req, res, 'version');
      if (key === null) return;
      const version = await findVersion(client, key);
      if (!version) {
        // "Not found" alone makes the tool feel broken when the graph is fine
        // and the caller simply omitted the `npm:` prefix.
        res.status(404).json({
          error: `version not found: ${key}`,
          suggestions: await suggestVersions(client, key),
        });
        return;
      }
      const instant = Number(req.query.at ?? Date.now());
      const exposures = await exposureAsOf(client, version, instant, {
        consistency: consistencyFor(req),
      });
      res.json({ instant, exposures });
    }),
  );

  // --- remediation ---------------------------------------------------------

  app.get(
    '/api/remediation',
    handle(async (req, res) => {
      const key = required(req, res, 'version');
      if (key === null) return;
      const version = await findVersion(client, key);
      if (!version) {
        // "Not found" alone makes the tool feel broken when the graph is fine
        // and the caller simply omitted the `npm:` prefix.
        res.status(404).json({
          error: `version not found: ${key}`,
          suggestions: await suggestVersions(client, key),
        });
        return;
      }
      const options = { ...traversal(), consistency: consistencyFor(req) };
      const report = await blastRadius(client, version, options);
      res.json(await planRemediation(client, report, options));
    }),
  );

  // --- maintainer web / typosquats ----------------------------------------

  app.get(
    '/api/maintainers',
    handle(async (req, res) => {
      const key = required(req, res, 'package');
      if (key === null) return;
      const pkg = await findPackage(client, key);
      if (!pkg) {
        res.status(404).json({ error: `package not found: ${key}` });
        return;
      }
      // `depth` widens the maintainer traversal a whole hop at a time; the
      // sheet's default question is the first ring, so an absent or unusable
      // value stays there rather than silently costing the engine more.
      const requestedDepth = Number(req.query.depth);
      res.json(
        await maintainerWeb(client, pkg, {
          pathCount: config.traversal.pathCount,
          resultLimit: config.traversal.resultLimit,
          depth: Number.isFinite(requestedDepth) && requestedDepth > 0 ? requestedDepth : undefined,
        }),
      );
    }),
  );

  app.get(
    '/api/typosquats',
    handle(async (_req, res) => {
      res.json(
        await typosquats(client, {
          recentDays: config.typosquat.recentDays,
          lowDownloadThreshold: config.typosquat.lowDownloadThreshold,
        }),
      );
    }),
  );

  // --- the Cypher console ---------------------------------------------------

  /**
   * Run an arbitrary read query against HydraDB.
   *
   * This exists so the dashboard can *show* the engine working rather than
   * assert it. Writes are refused: the console is a window into the graph, not
   * a way to mutate it from a browser tab.
   */
  app.post(
    '/api/cypher',
    handle(async (req, res) => {
      const body = req.body as {
        query?: string;
        consistency?: 'causal' | 'strong';
        transport?: 'http' | 'bolt';
      };
      const query = String(body.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'query is required' });
        return;
      }

      const mutating = /\b(CREATE|MERGE|DELETE|SET|REMOVE|DETACH)\b/i.test(query);
      if (mutating) {
        res.status(400).json({
          error:
            'the console is read-only. Mutations are available through the CLI ' +
            '(blastradius mark-compromised, load, scan).',
        });
        return;
      }

      const started = Date.now();

      // The same query, down the other transport. Bolt compatibility was only
      // ever asserted in `doctor`; sending a real user query through a stock
      // Neo4j driver makes it something a reader can check for themselves.
      if (body.transport === 'bolt') {
        try {
          const bolt = await boltQuery(query, {
            boltUrl: config.hydra.boltUrl,
            authToken: config.hydra.authToken,
            graphId: config.hydra.graphId,
          });
          res.json({
            columns: bolt.columns,
            rows: bolt.rows.slice(0, 200).map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  typeof value === 'object' && value !== null ? JSON.stringify(value) : value,
                ]),
              ),
            ),
            rowCount: bolt.rows.length,
            elapsedMs: bolt.elapsedMs,
            wallMs: Date.now() - started,
            readEpoch: null,
            transport: 'bolt',
            server: bolt.server,
          });
        } catch (error) {
          res.json({
            columns: [],
            rows: [],
            rowCount: 0,
            elapsedMs: Date.now() - started,
            wallMs: Date.now() - started,
            transport: 'bolt',
            queryError: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      try {
        const result = await client.query(query, {
          consistency: body.consistency ?? config.traversal.readConsistency,
          retries: 0,
        });
        // Paths are large; summarise them so one bad query cannot wedge the tab.
        const rows = result.records.slice(0, 200).map((record) => {
          const out: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(record)) {
            if (value && typeof value === 'object' && 'nodes' in value) {
              const path = value as { nodes: Array<{ properties: Record<string, unknown> }> };
              out[key] = `path(${path.nodes.length} nodes): ${path.nodes
                .map((n) => String(n.properties.key ?? n.properties.name ?? '?'))
                .join(' → ')}`;
            } else {
              out[key] = value;
            }
          }
          return out;
        });
        res.json({
          columns: result.columns,
          rows,
          rowCount: result.records.length,
          truncated: result.records.length > rows.length,
          elapsedMs: result.elapsedMs,
          wallMs: Date.now() - started,
          readEpoch: result.readEpoch,
          consistency: body.consistency ?? config.traversal.readConsistency,
        });
      } catch (error) {
        // A rejected query is a *result* here, not a server failure — the whole
        // point of the console is to see what the engine accepts.
        res.status(200).json({
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          elapsedMs: 0,
          wallMs: Date.now() - started,
          queryError: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  /** The engine's own metrics, for the live panel. */
  /** Resolve `?version=` or answer 400/404 exactly as the other sheets do. */
  const resolveVersion = async (key: string, req: Request, res: Response) => {
    const wanted = required(req, res, 'version');
    if (wanted === null) return null;
    const version = await findVersion(client, wanted);
    if (!version) {
      res.status(404).json({
        error: `version not found: ${wanted}`,
        suggestions: await suggestVersions(client, wanted),
      });
      return null;
    }
    return version;
  };

  app.get(
    '/api/advisory-radius',
    handle(async (req, res) => {
      const id = required(req, res, 'id');
      if (id === null) return;
      try {
        res.json(
          await advisoryRadius(client, id, {
            maxDepth: config.traversal.maxDepth,
            pathCount: config.traversal.pathCount,
            resultLimit: config.traversal.resultLimit,
            consistency: config.traversal.readConsistency,
          }),
        );
      } catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }),
  );

  app.get(
    '/api/drift',
    handle(async (_req, res) => {
      res.json(await lockfileDrift(client, { consistency: config.traversal.readConsistency }));
    }),
  );

  app.get(
    '/api/lab/budget',
    handle(async (req, res) => {
      const version = await resolveVersion('', req, res);
      if (!version) return;
      res.json(
        await calibrateBudget(client, version, {
          maxDepth: config.traversal.maxDepth,
          consistency: config.traversal.readConsistency,
        }),
      );
    }),
  );

  app.get(
    '/api/lab/consistency',
    handle(async (req, res) => {
      const version = await resolveVersion('', req, res);
      if (!version) return;
      res.json(
        await compareConsistency(client, version, {
          maxDepth: config.traversal.maxDepth,
          pathCount: config.traversal.pathCount,
          resultLimit: config.traversal.resultLimit,
        }),
      );
    }),
  );

  app.get(
    '/api/lab/ablation',
    handle(async (req, res) => {
      const version = await resolveVersion('', req, res);
      if (!version) return;
      res.json({
        rows: await ablateEdgeTypes(client, version, {
          maxDepth: config.traversal.maxDepth,
          pathCount: config.traversal.pathCount,
          resultLimit: config.traversal.resultLimit,
          consistency: config.traversal.readConsistency,
        }),
      });
    }),
  );

  app.get(
    '/api/engine',
    handle(async (_req, res) => {
      const text = await fetch(`${config.hydra.adminUrl.replace(/\/$/, '')}/metrics`, {
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.text());

      const metric = (name: string): number | null => {
        const match = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, 'm').exec(text);
        return match?.[1] ? Number(match[1]) : null;
      };
      /** Sum a labelled series across all its label sets. */
      const sum = (name: string): number => {
        let total = 0;
        for (const line of text.split('\n')) {
          if (!line.startsWith(name)) continue;
          const value = Number(line.trim().split(/\s+/).pop());
          if (Number.isFinite(value)) total += value;
        }
        return total;
      };
      /** Pull every label value of a labelled counter, e.g. per error class. */
      const byLabel = (name: string, label: string): Record<string, number> => {
        const out: Record<string, number> = {};
        const pattern = new RegExp(`^${name}\\{[^}]*${label}="([^"]+)"[^}]*\\}\\s+([0-9.eE+-]+)$`, 'gm');
        for (const match of text.matchAll(pattern)) {
          if (match[1]) out[match[1]] = Number(match[2]);
        }
        return out;
      };

      const attempts = sum('graph_write_attempts');
      const commits = sum('graph_write_commits');
      const retries = sum('graph_write_retries');

      res.json({
        ready: metric('graph_runtime_ready'),
        http: config.hydra.httpUrl,
        bolt: config.hydra.boltUrl,

        // What this server has asked of the engine.
        client: {
          queriesIssued: client.queryCount,
          totalQueryMs: Math.round(client.totalQueryMs),
          lastReadEpoch: client.lastReadEpoch,
          lastBookmark: client.lastBookmark,
          errorClasses: Object.fromEntries(client.errorClassCounts),
        },

        // What the engine has actually done, from its own counters.
        queries: {
          started: metric('graph_query_started'),
          completed: metric('graph_query_completed'),
          failed: metric('graph_query_failed'),
          rowsReturned: metric('graph_client_rows_returned'),
          // The engine's own taxonomy, no longer collapsed into one number.
          failedByClass: byLabel('graph_query_failed_by_class', 'error_class'),
          backpressureWaits: metric('graph_client_backpressure_waits'),
          cancellations: metric('graph_client_cancellations'),
          authFailures: metric('graph_query_auth_failures'),
          scopeDenials: metric('graph_query_scope_denials'),
        },

        // Write amplification: how much work a commit really costs.
        writes: {
          attempts,
          commits,
          retries,
          // >1 means the engine retried commits under contention.
          amplification: commits > 0 ? Number((attempts / commits).toFixed(3)) : null,
        },

        // The storage engine keeping itself honest.
        storage: {
          gcJobsStarted: sum('graph_gc_jobs_started'),
          gcJobsCompleted: sum('graph_gc_jobs_completed'),
          gcKeysDeleted: sum('graph_gc_keys_deleted'),
          gcDurationMs: Math.round(sum('graph_gc_duration_microseconds') / 1000),
          verifierRuns: sum('graph_verifier_runs'),
          verifierFailures: sum('graph_verifier_failures'),
        },

        // The sparse-linear-algebra path. Zero here is a real fact about this
        // workload, not a missing metric: nothing this product runs builds one.
        graphblas: {
          artifactSnapshots: sum('graph_query_graphblas_artifact_snapshots'),
          rebuiltSnapshots: sum('graph_query_graphblas_rebuilt_snapshots'),
          cacheMs: Math.round(sum('graph_query_graphblas_cache_microseconds') / 1000),
          sparseFallbacks: sum('graph_query_rust_sparse_fallbacks'),
        },

        compute: {
          tasks: sum('graph_compute_tasks'),
          queueMs: Math.round(sum('graph_compute_queue_microseconds') / 1000),
        },
      });
    }),
  );

  // --- insights -------------------------------------------------------------

  app.get(
    '/api/prioritise',
    handle(async (req, res) => {
      const versionKeyParam = required(req, res, 'version');
      if (versionKeyParam === null) return;
      const version = await findVersion(client, versionKeyParam);
      if (!version) {
        res.status(404).json({ error: `version not found: ${String(req.query.version)}` });
        return;
      }
      res.json(await prioritiseExposure(client, version, { ...traversal(), consistency: consistencyFor(req) }));
    }),
  );

  app.get(
    '/api/preflight',
    handle(async (req, res) => {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      res.json(await preflight(client, { ...traversal(), limit }));
    }),
  );

  app.get(
    '/api/advisories',
    handle(async (_req, res) => {
      res.json(await advisoriesQuery(client));
    }),
  );

  app.get(
    '/api/why',
    handle(async (req, res) => {
      const repoKey = required(req, res, 'repo');
      if (repoKey === null) return;
      const versionKey = required(req, res, 'version');
      if (versionKey === null) return;
      res.json(
        await explainPath(
          client,
          repoKey.includes('/') ? repoKey : `${config.org.name}/${repoKey}`,
          versionKey,
          traversal(),
        ),
      );
    }),
  );

  app.get(
    '/api/maintainer-radius',
    handle(async (req, res) => {
      // An omitted or misspelled parameter used to fall through as an empty
      // string and surface as `no maintainer named ""`, which tells the caller
      // nothing about what the endpoint actually wants.
      const username = String(req.query.username ?? '').trim();
      if (!username) {
        res.status(400).json({ error: 'required query parameter: username' });
        return;
      }
      res.json(await maintainerBlastRadius(client, username, traversal()));
    }),
  );

  // --- mutations -----------------------------------------------------------

  app.post(
    '/api/mark-compromised',
    handle(async (req, res) => {
      const body = req.body as { version?: string; from?: number; to?: number; advisory?: string };
      const version = await findVersion(client, String(body.version ?? ''));
      if (!version) {
        res.status(404).json({ error: `version not found: ${String(body.version)}` });
        return;
      }
      if (!body.from || !body.to) {
        res.status(400).json({ error: 'from and to (epoch ms) are required' });
        return;
      }
      await markCompromised(client, version.id, body.from, body.to, body.advisory ?? '');
      res.json({ ok: true, version: await findVersion(client, version.key) });
    }),
  );

  app.post(
    '/api/clear-compromised',
    handle(async (req, res) => {
      // This used to ignore its body entirely and clear everything, which meant
      // a caller naming one version got all forty-three wiped and a 200 back.
      // A destructive endpoint that silently discards the argument scoping it is
      // the wrong shape, so the scope is now explicit in both directions.
      const requested = typeof req.body?.version === 'string' ? req.body.version : null;
      const existing = await listCompromisedVersions(client);

      const targets = requested
        ? existing.filter((version) => version.key === requested)
        : existing;

      if (requested && targets.length === 0) {
        res.status(404).json({
          error: `not marked compromised: ${requested}`,
          marked: existing.map((version) => version.key),
        });
        return;
      }

      await clearCompromised(
        client,
        targets.map((version) => version.id),
      );
      statsCache.invalidate();
      res.json({ ok: true, cleared: targets.length, scope: requested ?? 'all' });
    }),
  );

  // --- simulation (server-sent events) ------------------------------------

  app.get('/api/simulate', (req, res) => {
    const scenarioName = String(req.query.scenario ?? 'tanstack-worm-2026');
    const scenario = findScenario(scenarioName);
    if (!scenario) {
      res.status(404).json({ error: `unknown scenario: ${scenarioName}` });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let cancelled = false;
    req.on('close', () => {
      cancelled = true;
    });

    void (async () => {
      try {
        const events = simulate(client, {
          scenario,
          seedVersionKey: req.query.seed ? String(req.query.seed) : undefined,
          realDurationMs: req.query.speed ? Number(req.query.speed) * 1000 : 24_000,
          ticks: req.query.ticks ? Number(req.query.ticks) : 12,
          traversal: traversal(),
          reset: req.query.reset !== 'false',
          now: config.org.simulatedNow,
        });
        for await (const event of events) {
          if (cancelled) break;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      } finally {
        res.end();
      }
    })();
  });

  // --- static dashboard ----------------------------------------------------

  // The dashboard's build sits in a different place depending on how this is
  // running: from a clone the CLI lives in packages/cli/dist, and from an npm
  // install the whole thing is bundled to dist/ at the package root. Both are
  // checked rather than assuming a layout, because getting this wrong serves a
  // working API with a blank page — the least useful possible failure.
  const here = dirname(fileURLToPath(import.meta.url));
  const dashboardDist = [
    resolve(here, '../../../dashboard/dist'), // clone: packages/cli/dist -> packages/dashboard/dist
    resolve(here, '../packages/dashboard/dist'), // npm: dist/ -> packages/dashboard/dist
    resolve(here, './dashboard'), // npm: dist/dashboard
  ].find((candidate) => existsSync(candidate));

  if (dashboardDist !== undefined) {
    const staticRoot = dashboardDist;
    app.use(express.static(staticRoot));
    app.get('*', (_req, res) => {
      res.sendFile(join(staticRoot, 'index.html'));
    });
  }

  await new Promise<void>((resolveListen) => {
    app.listen(port, () => {
      const out = process.stdout;
      out.write(`${bold('Blast Radius API')} listening on ${cyan(`http://127.0.0.1:${port}`)}\n`);
      if (dashboardDist !== undefined) {
        out.write(`${bold('Dashboard')}        ${cyan(`http://127.0.0.1:${port}`)}\n`);
      } else {
        out.write(
          dim(
            `dashboard bundle not built — run \`npm run build -w @blast/dashboard\`, ` +
              `or \`npm run dev -w @blast/dashboard\` for hot reload\n`,
          ),
        );
      }
      resolveListen();
    });
  });
}
