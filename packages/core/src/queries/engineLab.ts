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
