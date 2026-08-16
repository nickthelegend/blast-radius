/**
 * Incident simulation — the "attack clock".
 *
 * Replays a compromise against the live graph: mark a seed version malicious,
 * propagate along real `MAINTAINS` edges to other packages the same account can
 * publish, and re-run the blast-radius traversal as it spreads. Every
 * measurement is a real `algo.SSpaths` call against HydraDB, so the exposure
 * counts the clock prints are query results, not a scripted animation.
 *
 * Emitted as an async generator so the CLI and the dashboard's SSE endpoint can
 * consume exactly the same event stream.
 */
import type { HydraClient } from '../hydra/client.js';
import { clearCompromised, markManyCompromised } from '../hydra/loader.js';
import type { Scenario } from '../ingest/scenarios.js';
import { blastRadius, combinedExposure, type BlastRadiusReport } from '../queries/blastRadius.js';
import { findVersion, listCompromisedVersions, listRepos, type VersionRef } from '../queries/lookup.js';

export type SimulationEvent =
  | {
      type: 'start';
      scenario: Scenario;
      seed: VersionRef;
      windowFrom: number;
      windowTo: number;
      plannedArtifacts: number;
    }
  | {
      type: 'publish';
      elapsedMs: number;
      simulatedAt: number;
      versionKey: string;
      packageName: string;
      artifactIndex: number;
      totalArtifacts: number;
      viaMaintainer: string;
    }
  | {
      type: 'measure';
      elapsedMs: number;
      simulatedAt: number;
      exposedRepoCount: number;
      exposedPackageCount: number;
      queryMs: number;
      compromisedVersionCount: number;
    }
  | { type: 'done'; report: BlastRadiusReport; elapsedMs: number; compromisedVersionKeys: string[] }
  /** Emitted the instant the run begins, before any graph work, so the UI is
   *  never silent while the seed and propagation surface are resolved. */
  | { type: 'preparing'; scenario: string }
  | { type: 'error'; message: string };

export interface SimulationOptions {
  scenario: Scenario;
  /** Version to seed the compromise on. Defaults to the scenario's preference. */
  seedVersionKey?: string;
  /** Wall-clock milliseconds to compress the whole incident window into. */
  realDurationMs: number;
  /** Number of measurement ticks across the run. */
  ticks: number;
  traversal: { maxDepth: number; pathCount: number; resultLimit: number };
  /** Clear existing compromise markings before starting. */
  reset: boolean;
  now?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Path budget for the per-tick live gauge. See the comment at its use site. */
const TICK_PATH_BUDGET = 2000;

/**
 * The propagation surface of a stolen publish credential.
 *
 * A self-propagating worm does not stop at the first account's packages. It
 * publishes to those, harvests the credentials of whoever else maintains them,
 * and keeps going — which is how the TanStack worm reached dozens of packages
 * in minutes. That is a bounded traversal over `MAINTAINS`:
 *
 *     Package <-[:MAINTAINS]- Maintainer -[:MAINTAINS]-> Package <-[:MAINTAINS]- …
 *
 * so `algo.SSpaths` with `relDirection: 'both'` and an even `maxLen` returns the
 * whole credential-reachable set in a single call. Depth 2 is the first
 * account's packages, depth 4 adds everything the accounts co-maintaining those
 * can reach, and so on.
 *
 * The target list is ordered by how depended-upon each package is, because a
 * worm that reaches a widely-used package does far more damage than one that
 * reaches an obscure one.
 */
async function propagationTargets(
  client: HydraClient,
  seed: VersionRef,
  limit: number,
  hops: number,
  traversal: { pathCount: number; resultLimit: number },
): Promise<Array<{ versionKey: string; packageName: string; maintainer: string }>> {
  const pkg = await client.query(
    'MATCH (p:Package) WHERE p.key = $package_key RETURN p.id AS id LIMIT 1',
    { parameters: { package_key: seed.packageKey } },
  );
  const packageId = pkg.records[0]?.id;
  if (typeof packageId !== 'number') return [];

  const result = await client.query(
    `CALL algo.SSpaths({sourceNode: ${packageId}, relTypes: ['MAINTAINS'], ` +
      `relDirection: 'both', maxLen: ${hops}, pathCount: ${traversal.pathCount}, ` +
      `resultLimit: ${traversal.resultLimit}}) YIELD path RETURN path`,
  );

  const candidates = new Map<string, { name: string; maintainer: string; dependents: number }>();

  for (const record of result.records) {
    const path = record.path as { nodes: Array<{ labels: string[]; properties: Record<string, unknown> }> };
    if (!path?.nodes) continue;
    const last = path.nodes[path.nodes.length - 1];
    if (!last?.labels.includes('Package')) continue;

    const packageKey = typeof last.properties.key === 'string' ? last.properties.key : '';
    if (!packageKey || packageKey === seed.packageKey || candidates.has(packageKey)) continue;

    // The maintainer immediately before the package is the account that
    // published it — the credential the worm used to get there.
    const via = path.nodes[path.nodes.length - 2];
    const maintainer =
      via && typeof via.properties.username === 'string' ? via.properties.username : 'unknown';

    candidates.set(packageKey, {
      name: typeof last.properties.name === 'string' ? last.properties.name : packageKey,
      maintainer,
      dependents:
        typeof last.properties.dependent_count === 'number' ? last.properties.dependent_count : 0,
    });
  }

  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1].dependents - a[1].dependents)
    .slice(0, limit);

  // Resolve each to the version an attacker would publish over: the newest one.
  //
  // One query for the whole set, not one per package. HydraDB has no `IN`, so
  // the obvious shape is a lookup per candidate — and with 42 candidates that
  // is 42 sequential round trips *before the first event reaches the UI*,
  // leaving the operator staring at an idle screen for the better part of
  // twenty seconds after pressing "run". Reading every version once and
  // grouping in memory keeps it to a single paginated call.
  const wanted = new Map(ranked);
  const newest = new Map<string, { key: string; publishedAt: number }>();
  const allVersions = await client.query(
    'MATCH (v:Version) RETURN v.key AS key, v.package_key AS package_key, ' +
      'v.published_at AS published_at',
  );
  for (const record of allVersions.records) {
    const packageKey = typeof record.package_key === 'string' ? record.package_key : '';
    if (!wanted.has(packageKey)) continue;
    const key = typeof record.key === 'string' ? record.key : '';
    const publishedAt = typeof record.published_at === 'number' ? record.published_at : 0;
    const current = newest.get(packageKey);
    if (!current || publishedAt > current.publishedAt) newest.set(packageKey, { key, publishedAt });
  }

  const targets: Array<{ versionKey: string; packageName: string; maintainer: string }> = [];
  for (const [packageKey, info] of ranked) {
    const pick = newest.get(packageKey);
    if (!pick?.key) continue;
    targets.push({ versionKey: pick.key, packageName: info.name, maintainer: info.maintainer });
  }

  return targets;
}

export async function* simulate(
  client: HydraClient,
  options: SimulationOptions,
): AsyncGenerator<SimulationEvent> {
  const { scenario } = options;
  const now = options.now ?? Date.now();
  const windowFrom = scenario.from(now);
  const windowTo = scenario.to(now);

  yield { type: 'preparing', scenario: scenario.title };

  // Read the existing markings *before* clearing them: they name the incident
  // this dataset was generated around, and that is the best default seed.
  const alreadyMarked = await listCompromisedVersions(client);

  if (options.reset) {
    await clearCompromised(
      client,
      alreadyMarked.map((version) => version.id),
    );
  }

  // --- resolve the seed ----------------------------------------------------
  let seed: VersionRef | null = null;
  if (options.seedVersionKey) {
    seed = await findVersion(client, options.seedVersionKey);
    if (!seed) {
      yield { type: 'error', message: `version not found in the graph: ${options.seedVersionKey}` };
      return;
    }
  } else {
    // Prefer whatever was already marked compromised: after `make demo` that is
    // the incident the whole dataset was generated around. Where several are
    // marked — a previous simulation leaves its propagated versions behind —
    // the scenario's own preference order decides, rather than whichever key
    // happened to sort first.
    for (const packageKey of scenario.preferredPackages) {
      const match = alreadyMarked.find((version) => version.packageKey === packageKey);
      if (match) {
        seed = match;
        break;
      }
    }
    seed ??= alreadyMarked[0] ?? null;

    if (!seed) {
      // Otherwise pick the version other packages actually resolve to. Choosing
      // by publish date instead would routinely land on a version nothing
      // depends on, whose blast radius is empty by construction.
      for (const packageKey of scenario.preferredPackages) {
        const result = await client.query(
          'MATCH (a:Version)-[:RESOLVED_TO]->(b:Version) WHERE b.package_key = $package_key ' +
            'RETURN b.key AS key, count(*) AS dependents ORDER BY dependents DESC LIMIT 1',
          { parameters: { package_key: packageKey } },
        );
        const candidate = result.records[0]?.key;
        if (typeof candidate === 'string') {
          seed = await findVersion(client, candidate);
          if (seed) break;
        }
      }
    }
  }

  if (!seed) {
    yield {
      type: 'error',
      message:
        'no seed package from this scenario is present in the graph. ' +
        'Load one first with `blastradius load`.',
    };
    return;
  }

  const targets = await propagationTargets(
    client,
    seed,
    scenario.propagationTargets,
    scenario.propagationHops,
    { pathCount: options.traversal.pathCount, resultLimit: options.traversal.resultLimit },
  );
  const totalArtifacts = Math.min(scenario.artifactCount, 1 + targets.length);

  yield {
    type: 'start',
    scenario,
    seed,
    windowFrom,
    windowTo,
    plannedArtifacts: totalArtifacts,
  };

  // Seed goes live at the top of the window.
  await markManyCompromised(client, [
    { versionId: seed.id, from: windowFrom, to: windowTo, advisoryId: scenario.name },
  ]);

  const startedAt = performance.now();
  const compromisedKeys = [seed.key];

  yield {
    type: 'publish',
    elapsedMs: 0,
    simulatedAt: windowFrom,
    versionKey: seed.key,
    packageName: seed.packageName,
    artifactIndex: 1,
    totalArtifacts,
    viaMaintainer: 'initial compromise',
  };

  const windowSpan = windowTo - windowFrom;
  const tickInterval = options.realDurationMs / Math.max(1, options.ticks);
  let nextTarget = 0;

  // Targets for the combined-exposure query, fetched once.
  const repoKeys = (await listRepos(client)).map((repo) => repo.key);

  for (let tick = 1; tick <= options.ticks; tick++) {
    await sleep(tickInterval);
    const progress = tick / options.ticks;
    const elapsedMs = performance.now() - startedAt;
    // Capped below 1.0: an artifact published at the exact instant the window
    // closes would carry a zero-length compromise window, and the Time Machine
    // would then correctly report that nothing was ever exposed to it.
    const simulatedAt = windowFrom + Math.round(windowSpan * Math.min(progress, 0.9));

    // Publish the artifacts this tick is responsible for.
    const targetCount = Math.floor((totalArtifacts - 1) * progress);
    const batch: Array<{ versionId: number; from: number; to: number; advisoryId: string }> = [];
    const published: typeof targets = [];

    while (nextTarget < targetCount && nextTarget < targets.length) {
      const target = targets[nextTarget]!;
      const version = await findVersion(client, target.versionKey);
      nextTarget += 1;
      if (!version) continue;
      batch.push({
        versionId: version.id,
        from: simulatedAt,
        to: windowTo,
        advisoryId: scenario.name,
      });
      published.push(target);
      compromisedKeys.push(target.versionKey);
    }

    if (batch.length > 0) {
      await markManyCompromised(client, batch);
      for (let i = 0; i < published.length; i++) {
        const target = published[i]!;
        yield {
          type: 'publish',
          elapsedMs: performance.now() - startedAt,
          simulatedAt,
          versionKey: target.versionKey,
          packageName: target.packageName,
          artifactIndex: nextTarget - published.length + i + 2,
          totalArtifacts,
          viaMaintainer: target.maintainer,
        };
      }
    }

    // Measure exposure across *everything* compromised so far, not just the
    // seed — that is what makes the count climb as the worm spreads, and it is
    // one algo.MSpaths round trip rather than one traversal per package.
    //
    // The per-tick traversal runs on a bounded path budget. By the end of a
    // worm run there are 40+ compromised sources against every repo, and the
    // full 20k budget pushes a single call past the request timeout — which
    // stalls the clock mid-demo. This does not weaken the number being shown:
    // the exposed-repo count comes from the authoritative `RESOLVED` pin
    // queries inside `combinedExposure`, not from the traversal. The traversal
    // supplies the reachability view and the latency figure, both of which are
    // still real, just bounded. The final report re-runs at the full budget.
    const combined = await combinedExposure(client, compromisedKeys, repoKeys, {
      maxDepth: options.traversal.maxDepth,
      pathCount: Math.min(options.traversal.pathCount, TICK_PATH_BUDGET),
      resultLimit: Math.min(options.traversal.resultLimit, TICK_PATH_BUDGET),
    });

    // The reachable-package count still comes from the seed's own traversal.
    const report = await blastRadius(client, seed, {
      maxDepth: options.traversal.maxDepth,
      pathCount: options.traversal.pathCount,
      resultLimit: options.traversal.resultLimit,
    });

    yield {
      type: 'measure',
      elapsedMs: performance.now() - startedAt,
      simulatedAt,
      exposedRepoCount: combined.exposedRepos.size,
      exposedPackageCount: report.exposedPackages.length,
      queryMs: combined.elapsedMs,
      compromisedVersionCount: compromisedKeys.length,
    };
  }

  const finalReport = await blastRadius(client, seed, {
    maxDepth: options.traversal.maxDepth,
    pathCount: options.traversal.pathCount,
    resultLimit: options.traversal.resultLimit,
  });

  yield {
    type: 'done',
    report: finalReport,
    elapsedMs: performance.now() - startedAt,
    compromisedVersionKeys: compromisedKeys,
  };
}
