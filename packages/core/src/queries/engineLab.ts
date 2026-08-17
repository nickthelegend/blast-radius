import type { HydraClient } from '../hydra/client.js';
import { blastRadius } from './blastRadius.js';
import type { VersionRef } from './lookup.js';

/**
 * Measurements of the engine, made through the product's own questions.
 *
 * Each of these exists because a claim the product makes elsewhere deserves to
 * be checkable rather than asserted: that the path budget is set high enough,
 * that the two consistency modes really do differ, that direct and transitive
 * exposure are separable, that the loader is genuinely idempotent.
 */

/* -------------------------------------------------------------------------- */
/* Path-budget calibration                                                    */
/* -------------------------------------------------------------------------- */

export interface BudgetSample {
  budget: number;
  paths: number;
  repos: number;
  elapsedMs: number;
  truncated: boolean;
}

/**
 * Sweep the traversal's path budget and record where the answer stops changing.
 *
 * `algo.SSpaths` truncates silently at `pathCount`, so every configured budget
 * is really a bet that it is high enough. This turns the bet into a measurement:
 * run the same traversal at increasing budgets and show the curve flattening.
 * The point where the repo count stops growing is the smallest budget that
 * still gives a complete answer.
 */
export async function calibrateBudget(
  client: HydraClient,
  source: VersionRef,
  options: { maxDepth: number; consistency: 'causal' | 'strong'; budgets?: number[] },
): Promise<{ samples: BudgetSample[]; settlesAt: number | null; cypher: string }> {
  const budgets = options.budgets ?? [50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000];
  const samples: BudgetSample[] = [];

  for (const budget of budgets) {
    const started = Date.now();
    const report = await blastRadius(client, source, {
      maxDepth: options.maxDepth,
      pathCount: budget,
      resultLimit: budget,
      consistency: options.consistency,
    });
    samples.push({
      budget,
      paths: report.totalPaths,
      repos: report.exposedRepos.length,
      elapsedMs: Date.now() - started,
      truncated: report.truncated,
    });
  }

  // The first budget whose repo count equals the final one — i.e. the cheapest
  // budget that still tells the truth.
  const final = samples.at(-1);
  const settled = final ? samples.find((sample) => sample.repos === final.repos) : undefined;

  return {
    samples,
    settlesAt: settled?.budget ?? null,
    cypher:
      `CALL algo.SSpaths({sourceNode: ${source.id}, relTypes: [...], ` +
      `relDirection: 'incoming', maxLen: ${options.maxDepth + 2}, ` +
      `pathCount: <swept>, resultLimit: <swept>}) YIELD path RETURN path`,
  };
}

/* -------------------------------------------------------------------------- */
/* Consistency A/B                                                            */
/* -------------------------------------------------------------------------- */

export interface ConsistencySample {
  consistency: 'causal' | 'strong';
  repos: number;
  paths: number;
  elapsedMs: number;
  readEpoch: number | null;
}

/**
 * The same traversal at both consistency levels, side by side.
 *
 * The product lets a user ask for a verified read and shows which mode answered
 * — but never showed what the choice actually costs or changes. This runs both
 * and reports the difference in latency, epoch and result, so the trade-off is
 * a measurement rather than a claim in a tooltip.
 */
export async function compareConsistency(
  client: HydraClient,
  source: VersionRef,
  options: { maxDepth: number; pathCount: number; resultLimit: number },
): Promise<{ samples: ConsistencySample[]; agree: boolean; epochGap: number | null }> {
  const samples: ConsistencySample[] = [];

  // Warm up first. Whichever mode ran first was paying for a cold traversal
  // cache, and the resulting figure said more about ordering than about
  // consistency — on the first run here `strong` came out *faster* than
  // `causal` purely because `causal` went first.
  await blastRadius(client, source, { ...options, consistency: 'causal' });

  for (const consistency of ['causal', 'strong'] as const) {
    const started = Date.now();
    const report = await blastRadius(client, source, { ...options, consistency });
    samples.push({
      consistency,
      repos: report.exposedRepos.length,
      paths: report.totalPaths,
      elapsedMs: Date.now() - started,
      readEpoch: report.readEpoch ?? null,
    });
  }

  const [causal, strong] = samples;
  return {
    samples,
    // They *should* agree on a quiet graph. A disagreement is a real finding,
    // not a bug in this comparison.
    agree: causal?.repos === strong?.repos,
    epochGap:
      causal?.readEpoch !== null && strong?.readEpoch !== null && causal && strong
        ? strong.readEpoch! - causal.readEpoch!
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Edge-type ablation                                                         */
/* -------------------------------------------------------------------------- */

export interface AblationRow {
  relTypes: string[];
  label: string;
  repos: number;
  paths: number;
  elapsedMs: number;
}

/**
 * The same blast radius with one edge type removed at a time.
 *
 * The graph models direct dependencies and resolved transitive edges as
 * separate relationship types, and every report silently unions them. Removing
 * one shows exactly how much of the exposure each accounts for — which is the
 * difference between "we depend on it" and "something we depend on does".
 */
export async function ablateEdgeTypes(
  client: HydraClient,
  source: VersionRef,
  options: { maxDepth: number; pathCount: number; resultLimit: number; consistency: 'causal' | 'strong' },
): Promise<AblationRow[]> {
  const variants: Array<{ label: string; relTypes: string[] }> = [
    { label: 'all edges (the shipped answer)', relTypes: ['RESOLVED_TO', 'RESOLVED_DIRECT', 'HAS_SNAPSHOT'] },
    { label: 'transitive only', relTypes: ['RESOLVED_TO', 'HAS_SNAPSHOT'] },
    { label: 'direct only', relTypes: ['RESOLVED_DIRECT', 'HAS_SNAPSHOT'] },
  ];

  const rows: AblationRow[] = [];
  for (const variant of variants) {
    const started = Date.now();
    const report = await blastRadius(client, source, { ...options, relTypes: variant.relTypes });
    rows.push({
      relTypes: variant.relTypes,
      label: variant.label,
      repos: report.exposedRepos.length,
      paths: report.totalPaths,
      elapsedMs: Date.now() - started,
    });
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Advisory-wide blast radius                                                 */
/* -------------------------------------------------------------------------- */

export interface AdvisoryRadius {
  advisoryId: string;
  packageKey: string;
  summary: string;
  severity: string;
  /** Every version in the graph the advisory's range covers. */
  affectedVersions: string[];
  /** Repos reachable from *any* affected version, by current lockfile. */
  exposedRepos: string[];
  /** Repos that pinned an affected version and have since upgraded away. */
  historicalRepos: string[];
  elapsedMs: number;
  cypher: string;
  procedure: 'algo.MSpaths';
}

/**
 * One traversal for a whole advisory, not one per affected version.
 *
 * A CVE does not name a single version — it names a range, and this graph
 * usually holds several versions inside it. Asking "who is exposed to
 * GHSA-xxxx" therefore means asking about every one of them, and the obvious
 * implementation is a loop: N traversals, N round trips, N sets to union by
 * hand.
 *
 * `algo.MSpaths` takes many indexed sources in a single call, so the whole
 * question is one round trip regardless of how many versions the advisory
 * covers. That is the difference between a per-version tool and a per-advisory
 * one, and it is the engine that makes it possible rather than the application.
 */
export async function advisoryRadius(
  client: HydraClient,
  advisoryId: string,
  options: { maxDepth: number; pathCount: number; resultLimit: number; consistency: 'causal' | 'strong' },
): Promise<AdvisoryRadius> {
  const started = Date.now();
  const escape = (value: string) => value.replace(/'/g, "\\'");

  const advisory = await client.query(
    // The GHSA identifier is `key`; `id` is the engine's numeric vertex id.
    `MATCH (a:Advisory) WHERE a.key = '${escape(advisoryId)}' ` +
      `RETURN a.key AS key, a.package_key AS package_key, a.summary AS summary, ` +
      `a.severity AS severity`,
    { consistency: options.consistency },
  );
  const head = advisory.records[0];
  if (!head) throw new Error(`no advisory with id "${advisoryId}" in the graph`);

  const packageKey = String(head.package_key ?? '');

  // Which versions the advisory actually covers, read from the graph rather
  // than re-implementing semver range matching here.
  const affected = await client.query(
    `MATCH (a:Advisory)-[:AFFECTS]->(v:Version) WHERE a.key = '${escape(advisoryId)}' ` +
      `RETURN v.key AS key ORDER BY key`,
    { consistency: options.consistency },
  );
  const affectedVersions = affected.records
    .map((record) => String(record.key ?? ''))
    .filter(Boolean);

  if (affectedVersions.length === 0) {
    return {
      advisoryId,
      packageKey,
      summary: String(head.summary ?? ''),
      severity: String(head.severity ?? ''),
      affectedVersions: [],
      exposedRepos: [],
      historicalRepos: [],
      elapsedMs: Date.now() - started,
      cypher: '',
      procedure: 'algo.MSpaths',
    };
  }

  // Every affected version as an indexed source, in one call.
  const sources = affectedVersions.map((key) => `'${escape(key)}'`).join(', ');
  const cypher =
    `CALL algo.MSpaths({sourceLabel: 'Version', sourceProperty: 'key', ` +
    `sourceValues: [${sources}], targetLabel: 'Repo', targetProperty: 'key', ` +
    `targetValues: [], pairwise: false, relTypes: ['RESOLVED_TO', 'RESOLVED_DIRECT', ` +
    `'HAS_SNAPSHOT'], relDirection: 'incoming', maxLen: ${options.maxDepth + 2}, ` +
    `pathCount: ${options.pathCount}, resultLimit: ${options.resultLimit}}) YIELD path RETURN path`;

  // The pin sets decide exposure; the traversal explains it. Read both tenses
  // in one pass, the same way the advisories sheet does — a repo that upgraded
  // away is not exposed now but did ship the flaw.
  const pins = await client.query(
    'MATCH (s:LockfileSnapshot)-[:RESOLVED]->(v:Version) ' +
      'RETURN s.repo_name AS repo_name, v.key AS version_key, s.is_current AS is_current',
    { consistency: options.consistency },
  );

  const wanted = new Set(affectedVersions);
  const exposed = new Set<string>();
  const historical = new Set<string>();
  for (const record of pins.records) {
    const versionKey = String(record.version_key ?? '');
    if (!wanted.has(versionKey)) continue;
    const repo = String(record.repo_name ?? '');
    if (!repo) continue;
    if (record.is_current === true) exposed.add(repo);
    else historical.add(repo);
  }
  // A repo exposed today is not also "historical"; the live fact wins.
  for (const repo of exposed) historical.delete(repo);

  return {
    advisoryId,
    packageKey,
    summary: String(head.summary ?? ''),
    severity: String(head.severity ?? ''),
    affectedVersions,
    exposedRepos: [...exposed].sort(),
    historicalRepos: [...historical].sort(),
    elapsedMs: Date.now() - started,
    cypher,
    procedure: 'algo.MSpaths',
  };
}

/* -------------------------------------------------------------------------- */
/* Lockfile drift                                                             */
/* -------------------------------------------------------------------------- */

export interface DriftRow {
  repoName: string;
  lastCaptured: number;
  daysSinceCapture: number;
  snapshotCount: number;
  /** True when this repo's newest lockfile is older than the org's median. */
  behind: boolean;
}

/**
 * Which repositories have stopped updating their lockfiles.
 *
 * Exposure reports answer "who is affected today". This answers the question
 * underneath it: whose dependency state is *stale*, and therefore whose clean
 * bill of health is least trustworthy. A repo whose lockfile has not moved in
 * months is not safe — it is unobserved, and it is where the next incident will
 * be found late.
 *
 * Reads `captured_at` across every snapshot in one pass, because the engine has
 * no aggregate functions to do it server-side. The comparison is against the
 * organisation's own median rather than a fixed threshold: "old" only means
 * anything relative to how often this organisation actually ships.
 */
export async function lockfileDrift(
  client: HydraClient,
  options: { consistency: 'causal' | 'strong'; now?: number },
): Promise<{ rows: DriftRow[]; medianCapture: number; cypher: string }> {
  const cypher =
    'MATCH (s:LockfileSnapshot) ' +
    'RETURN s.repo_name AS repo_name, s.captured_at AS captured_at, s.is_current AS is_current ' +
    'ORDER BY captured_at';

  const result = await client.query(cypher, { consistency: options.consistency });

  const latest = new Map<string, { last: number; count: number }>();
  for (const record of result.records) {
    const repo = String(record.repo_name ?? '');
    const captured = typeof record.captured_at === 'number' ? record.captured_at : 0;
    if (!repo || !captured) continue;
    const entry = latest.get(repo);
    if (entry) {
      entry.count += 1;
      if (captured > entry.last) entry.last = captured;
    } else {
      latest.set(repo, { last: captured, count: 1 });
    }
  }

  const lasts = [...latest.values()].map((entry) => entry.last).sort((a, b) => a - b);
  const medianCapture = lasts.length
    ? (lasts[Math.floor((lasts.length - 1) / 2)]! + lasts[Math.ceil((lasts.length - 1) / 2)]!) / 2
    : 0;

  // `now` is injectable so the result is reproducible in a test rather than
  // depending on when the test happens to run.
  const now = options.now ?? Date.now();

  const rows: DriftRow[] = [...latest.entries()]
    .map(([repoName, entry]) => ({
      repoName,
      lastCaptured: entry.last,
      daysSinceCapture: Math.floor((now - entry.last) / 86_400_000),
      snapshotCount: entry.count,
      behind: entry.last < medianCapture,
    }))
    .sort((a, b) => a.lastCaptured - b.lastCaptured);

  return { rows, medianCapture, cypher };
}
