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
  listVersionsOfPackage,
  maintainerWeb,
  markCompromised,
  SCENARIOS,
  simulate,
  timeMachine,
  typosquats,
  type GraphPath,
} from '@blast/core';
import express, { type Request, type Response } from 'express';

import { createContext } from '../context.js';
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
      const [stats, compromised, repos] = await Promise.all([
        graphStats(client),
        listCompromisedVersions(client),
        listRepos(client, config.org.name),
      ]);
      res.json({
        stats,
        compromised,
        repos,
        org: config.org.name,
        simulatedNow: config.org.simulatedNow,
        traversal: {
          maxDepth: config.traversal.maxDepth,
          pathCount: config.traversal.pathCount,
        },
      });
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
      // HydraDB's WHERE supports STARTS WITH, which is exactly a prefix search.
      const result = await client.query(
        'MATCH (p:Package) WHERE p.key STARTS WITH $prefix ' +
          'RETURN p.key AS key, p.name AS name, p.dependent_count AS dependent_count, ' +
          'p.downloads AS downloads ORDER BY dependent_count DESC LIMIT 25',
        { parameters: { prefix: query } },
      );
      res.json(result.records);
    }),
  );

  app.get(
    '/api/versions',
    handle(async (req, res) => {
      const packageKey = String(req.query.package ?? '');
      const versions = await listVersionsOfPackage(client, packageKey);
      res.json({ versions, timeline: buildVersionTimeline(versions) });
    }),
  );

  // --- blast radius --------------------------------------------------------

  app.get(
    '/api/exposure',
    handle(async (req, res) => {
      const key = String(req.query.version ?? '');
      const version = await findVersion(client, key);
      if (!version) {
        res.status(404).json({ error: `version not found: ${key}` });
        return;
      }

      const depth = req.query.depth ? Number(req.query.depth) : config.traversal.maxDepth;
      const repos = String(req.query.repos ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      const options = { ...traversal(), maxDepth: depth, consistency: consistencyFor(req) };
      const report =
        repos.length > 0
          ? await blastRadiusForRepos(client, version, repos, {
              ...options,
              pairwise: req.query.pairwise === 'true',
            })
          : await blastRadius(client, version, options);

      res.json(report);
    }),
  );

  /** Node/link payload for the force-directed graph view. */
  app.get(
    '/api/graph',
    handle(async (req, res) => {
      const key = String(req.query.version ?? '');
      const version = await findVersion(client, key);
      if (!version) {
        res.status(404).json({ error: `version not found: ${key}` });
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
      const key = String(req.query.version ?? '');
      const version = await findVersion(client, key);
      if (!version) {
        res.status(404).json({ error: `version not found: ${key}` });
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
      const key = String(req.query.version ?? '');
      const version = await findVersion(client, key);
      if (!version) {
        res.status(404).json({ error: `version not found: ${key}` });
        return;
      }
      const instant = Number(req.query.at ?? Date.now());
      const exposures = await exposureAsOf(client, version, instant, {
        consistency: consistencyFor(req),
      });
      res.json({ instant, exposures });
    }),
  );

  // --- maintainer web / typosquats ----------------------------------------

  app.get(
    '/api/maintainers',
    handle(async (req, res) => {
      const key = String(req.query.package ?? '');
      const pkg = await findPackage(client, key);
      if (!pkg) {
        res.status(404).json({ error: `package not found: ${key}` });
        return;
      }
      res.json(
        await maintainerWeb(client, pkg, {
          pathCount: config.traversal.pathCount,
          resultLimit: config.traversal.resultLimit,
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
    handle(async (_req, res) => {
      const existing = await listCompromisedVersions(client);
      await clearCompromised(
        client,
        existing.map((version) => version.id),
      );
      res.json({ ok: true, cleared: existing.length });
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

  const here = dirname(fileURLToPath(import.meta.url));
  const dashboardDist = resolve(here, '../../../dashboard/dist');
  if (existsSync(dashboardDist)) {
    app.use(express.static(dashboardDist));
    app.get('*', (_req, res) => {
      res.sendFile(join(dashboardDist, 'index.html'));
    });
  }

  await new Promise<void>((resolveListen) => {
    app.listen(port, () => {
      const out = process.stdout;
      out.write(`${bold('Blast Radius API')} listening on ${cyan(`http://127.0.0.1:${port}`)}\n`);
      if (existsSync(dashboardDist)) {
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
