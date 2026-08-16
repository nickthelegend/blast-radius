import { useEffect, useState } from 'react';

import { Conditions } from '../components/Conditions.js';
import { Plotting } from '../components/Plotting.js';
import { api, fmtMs, type EngineReport } from '../lib/api.js';

const num = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString();

/**
 * The engine, reporting on itself.
 *
 * Every other sheet shows what the graph says. This one shows what the *engine*
 * says: how many queries it has run, how its failures classify, how much a
 * commit really costs, whether garbage collection and the verifier have run,
 * and whether the sparse-linear-algebra path was ever used.
 *
 * It exists because the product's first principle is *show the query*, and the
 * honest extension of that is showing the machine underneath — including the
 * numbers that read zero. A zero here is a fact about this workload, not a
 * missing metric, and saying so is more useful than hiding the row.
 */
export function EngineView(): JSX.Element {
  const [report, setReport] = useState<EngineReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .engine()
        .then((result) => {
          if (!cancelled) setReport(result);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    void load();
    // The counters move while you watch, which is the point.
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!report) return <Plotting label="reading the engine's own counters" rows={3} />;

  const failed = Object.entries(report.queries.failedByClass).filter(([, n]) => n > 0);
  const clientClasses = Object.entries(report.client.errorClasses);

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Engine</h2>
        <p className="sub">
          Not the graph — the machine underneath it, from HydraDB&apos;s own{' '}
          <span className="mono">/metrics</span>. These counters advance while you watch.
        </p>
        <div className="stat-row">
          <div className="stat">
            <span className="value">{num(report.queries.completed)}</span>
            <span className="label">queries completed</span>
          </div>
          <div className="stat">
            <span className="value">{num(report.queries.rowsReturned)}</span>
            <span className="label">rows returned</span>
          </div>
          <div className="stat">
            <span className="value">{num(report.writes.commits)}</span>
            <span className="label">write commits</span>
          </div>
          <div className="stat">
            <span className={report.writes.amplification === 1 ? 'value ok' : 'value'}>
              {report.writes.amplification ?? '—'}×
            </span>
            <span className="label">write amplification</span>
          </div>
        </div>
        <Conditions
          entries={[
            ['ready', report.ready === 1 ? 'yes' : 'no'],
            ['http', report.http],
            ['bolt', report.bolt],
            ['read epoch', report.client.lastReadEpoch],
          ]}
        />
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Failures, by the engine&apos;s own class</h2>
          <p className="sub">
            HydraDB classes a failure twelve ways, and they want opposite responses: contention and
            routing are worth another attempt, a rejected query never is, and admission means it is
            already overloaded. This client retries on the class, not the status code.
          </p>
          {failed.length === 0 && <div className="empty">No failures in any class.</div>}
          {failed.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>class</th>
                  <th>count</th>
                  <th>retried?</th>
                </tr>
              </thead>
              <tbody>
                {failed.map(([name, count]) => {
                  const retried = ['contention', 'routing', 'fencing'].includes(name);
                  return (
                    <tr key={name}>
                      <td className="mono">{name}</td>
                      <td className="mono">{count}</td>
                      <td>
                        <span className={`pill ${retried ? 'warn' : 'ok'}`}>
                          {retried ? 'retried' : 'surfaced'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {clientClasses.length > 0 && (
            <div className="explainer">
              This server has classified{' '}
              {clientClasses.map(([name, count]) => `${count} ${name}`).join(', ')} since it started.
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Storage and compute</h2>
          <p className="sub">
            The object-store engine keeping itself honest. A zero is a fact about this workload, not
            a missing metric.
          </p>
          <table>
            <tbody>
              <tr>
                <td>garbage collection</td>
                <td className="mono">
                  {num(report.storage.gcJobsCompleted)}/{num(report.storage.gcJobsStarted)} jobs ·{' '}
                  {num(report.storage.gcKeysDeleted)} keys
                </td>
              </tr>
              <tr>
                <td>verifier</td>
                <td className="mono">
                  {num(report.storage.verifierRuns)} runs ·{' '}
                  <span className={report.storage.verifierFailures > 0 ? 'danger' : 'ok'}>
                    {num(report.storage.verifierFailures)} failures
                  </span>
                </td>
              </tr>
              <tr>
                <td>GraphBLAS artifacts</td>
                <td className="mono">
                  {num(report.graphblas.artifactSnapshots)} built ·{' '}
                  {num(report.graphblas.sparseFallbacks)} sparse fallbacks
                </td>
              </tr>
              <tr>
                <td>compute queue</td>
                <td className="mono">
                  {num(report.compute.tasks)} tasks · {fmtMs(report.compute.queueMs)}
                </td>
              </tr>
              <tr>
                <td>backpressure waits</td>
                <td className="mono">{num(report.queries.backpressureWaits)}</td>
              </tr>
              <tr>
                <td>auth failures / scope denials</td>
                <td className="mono">
                  {num(report.queries.authFailures)} / {num(report.queries.scopeDenials)}
                </td>
              </tr>
            </tbody>
          </table>
          {report.graphblas.artifactSnapshots === 0 && (
            <div className="explainer">
              The engine has a sparse-linear-algebra path and this workload never triggers it — path
              procedures over a graph this size are answered without building a GraphBLAS artifact.
              Recorded rather than hidden.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
