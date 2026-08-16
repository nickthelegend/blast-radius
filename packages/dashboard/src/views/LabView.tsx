import { useEffect, useRef, useState } from 'react';

import { Conditions } from '../components/Conditions.js';
import { CopyTable } from '../components/CopyTable.js';
import { Plotting } from '../components/Plotting.js';
import {
  api,
  fmtMs,
  type AblationRow,
  type BudgetSample,
  type ConsistencySample,
} from '../lib/api.js';

/**
 * The measurements behind the numbers the other sheets print.
 *
 * Every sheet here answers a question the product otherwise asks the reader to
 * take on trust: is the path budget high enough, does the consistency choice
 * cost anything, and how much of an exposure is direct rather than inherited.
 * None of these are configuration screens — they are experiments, run live
 * against the engine, that either confirm the shipped settings or don't.
 */
export function LabView({ version }: { version: string }): JSX.Element {
  const [budget, setBudget] = useState<{
    samples: BudgetSample[];
    settlesAt: number | null;
  } | null>(null);
  const [consistency, setConsistency] = useState<{
    samples: ConsistencySample[];
    agree: boolean;
    epochGap: number | null;
  } | null>(null);
  const [ablation, setAblation] = useState<AblationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ablationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBudget(null);
    setConsistency(null);
    setAblation(null);
    setError(null);

    // Three independent experiments; each renders as soon as it lands rather
    // than making the reader wait for the slowest.
    void api
      .labBudget(version)
      .then((r) => !cancelled && setBudget(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    void api
      .labConsistency(version)
      .then((r) => !cancelled && setConsistency(r))
      .catch(() => undefined);
    void api
      .labAblation(version)
      .then((r) => !cancelled && setAblation(r.rows))
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [version]);

  if (error) return <div className="error">{error}</div>;

  const maxPaths = budget ? Math.max(...budget.samples.map((s) => s.paths), 1) : 1;
  // Name the modes explicitly rather than "slowest" and "fastest": the claim
  // being made is about what verification costs, so it has to be false when
  // verification turns out to be the cheaper of the two.
  const causal = consistency?.samples.find((s) => s.consistency === 'causal') ?? null;
  const strong = consistency?.samples.find((s) => s.consistency === 'strong') ?? null;
  const verificationCost =
    causal && strong && causal.elapsedMs > 0
      ? Math.round(((strong.elapsedMs - causal.elapsedMs) / causal.elapsedMs) * 100)
      : null;

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Path budget calibration</h2>
        <p className="sub">
          <span className="mono">algo.SSpaths</span> truncates <em>silently</em> at its path budget,
          so every configured value is a bet that it is high enough. This runs the same traversal at
          increasing budgets and shows where the answer stops changing.
        </p>
        {!budget && <Plotting label="sweeping the path budget" rows={4} />}
        {budget && (
          <>
            <table>
              <thead>
                <tr>
                  <th>budget</th>
                  <th>paths returned</th>
                  <th />
                  <th>repos</th>
                  <th>elapsed</th>
                  <th>state</th>
                </tr>
              </thead>
              <tbody>
                {budget.samples.map((sample) => (
                  <tr key={sample.budget}>
                    <td className="mono">{sample.budget.toLocaleString()}</td>
                    <td className="mono">{sample.paths.toLocaleString()}</td>
                    <td style={{ width: '30%' }}>
                      <div
                        className="bar"
                        style={{ width: `${Math.round((sample.paths / maxPaths) * 100)}%` }}
                      />
                    </td>
                    <td className="mono">{sample.repos}</td>
                    <td className="mono">{fmtMs(sample.elapsedMs)}</td>
                    <td>
                      <span className={`pill ${sample.truncated ? 'warn' : 'ok'}`}>
                        {sample.truncated ? 'truncated' : 'complete'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="explainer">
              The repository count settles at a budget of{' '}
              <strong>{budget.settlesAt?.toLocaleString() ?? '—'}</strong> because the authoritative
              pin set is read separately from the traversal — but the <em>path</em> count keeps
              growing until the budget stops binding. A report quoting paths from a truncated
              traversal would be under-reporting, which is why the shipped budget sits above the
              settling point rather than at it.
            </div>
          </>
        )}
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Consistency, priced</h2>
          <p className="sub">
            The same traversal at both levels. <span className="mono">strong</span> refreshes the
            snapshot from object storage before answering; <span className="mono">causal</span>{' '}
            reads the session&apos;s own view.
          </p>
          {!consistency && <Plotting label="running both consistency modes" rows={2} />}
          {consistency && (
            <>
              <table>
                <thead>
                  <tr>
                    <th>mode</th>
                    <th>elapsed</th>
                    <th>epoch</th>
                    <th>repos</th>
                  </tr>
                </thead>
                <tbody>
                  {consistency.samples.map((sample) => (
                    <tr key={sample.consistency}>
                      <td className="mono">{sample.consistency}</td>
                      <td className="mono">{fmtMs(sample.elapsedMs)}</td>
                      <td className="mono">{sample.readEpoch ?? '—'}</td>
                      <td className="mono">{sample.repos}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="explainer">
                {consistency.agree
                  ? 'Both modes returned the same exposure set, which is what a quiet graph should do — the difference is latency, not answer.'
                  : 'The two modes disagreed. On a graph being written to, that is the staleness window made visible rather than a fault.'}{' '}
                {verificationCost === null
                  ? ''
                  : verificationCost > 5
                    ? `Verification cost ${verificationCost}% more latency on this run.`
                    : verificationCost < -5
                      ? `Verification was ${Math.abs(verificationCost)}% faster on this run — the ` +
                        `snapshot was already current, so the refresh cost nothing and normal ` +
                        `variance dominated.`
                      : 'The two modes cost the same here, within noise.'}
              </div>
            </>
          )}
        </div>

        <div className="panel" ref={ablationRef}>
          <h2>Where the exposure comes from</h2>
          <p className="sub">
            The same blast radius with one relationship type removed at a time — the difference
            between depending on a package and inheriting it.
          </p>
          {!ablation && <Plotting label="ablating edge types" rows={3} />}
          {ablation && (
            <>
              <CopyTable targetRef={ablationRef} caption="edge-type ablation" />
              <table>
                <thead>
                  <tr>
                    <th>traversal</th>
                    <th>paths</th>
                    <th>elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {ablation.map((row) => (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      <td className="mono">{row.paths.toLocaleString()}</td>
                      <td className="mono">{fmtMs(row.elapsedMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ablation.some((row) => row.label.startsWith('direct') && row.paths === 0) && (
                <div className="explainer">
                  No repository reaches this version through a <em>direct</em> dependency edge.
                  Every exposure here is inherited through something else — which is exactly the
                  case a manifest-level scanner misses and a resolved-graph traversal catches.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Conditions
        entries={[
          ['experiments', '3'],
          ['procedure', 'algo.SSpaths'],
          ['source', version],
        ]}
      />
    </div>
  );
}
