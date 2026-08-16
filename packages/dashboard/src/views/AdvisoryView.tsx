import { useEffect, useMemo, useState } from 'react';

import { Conditions } from '../components/Conditions.js';
import { Plotting } from '../components/Plotting.js';
import { api, fmtDate, fmtMs, type AdvisoryView as Advisory } from '../lib/api.js';

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MODERATE: 2,
  LOW: 1,
};

const severityClass = (severity: string): string =>
  severity === 'CRITICAL' || severity === 'HIGH' ? 'danger' : severity === 'MODERATE' ? 'warn' : 'ok';

/**
 * Real OSV advisories, in both tenses.
 *
 * A current-state scanner reads this estate and reports nothing: no lockfile in
 * use today pins a version any of these forty records affects. That is true and
 * it is half the story. Six repositories shipped an affected version and have
 * since upgraded away — which no scanner can see, because the evidence is in a
 * lockfile that no longer exists on disk.
 *
 * So the two columns are the point of the sheet, not a detail of it.
 */
export function AdvisoryView(): JSX.Element {
  const [advisories, setAdvisories] = useState<Advisory[] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [onlyReaching, setOnlyReaching] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .advisories()
      .then((result) => {
        if (cancelled) return;
        setAdvisories(result.advisories);
        setElapsed(result.elapsedMs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(() => {
    if (!advisories) return [];
    const rows = onlyReaching
      ? advisories.filter((a) => a.exposedRepos.length + a.historicalRepos.length > 0)
      : advisories;
    return [...rows].sort(
      (a, b) =>
        b.exposedRepos.length - a.exposedRepos.length ||
        b.historicalRepos.length - a.historicalRepos.length ||
        (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0),
    );
  }, [advisories, onlyReaching]);

  const everShipped = useMemo(
    () => [...new Set((advisories ?? []).flatMap((a) => a.historicalRepos))].sort(),
    [advisories],
  );
  const liveCount = (advisories ?? []).filter((a) => a.exposedRepos.length > 0).length;

  if (error) return <div className="error">{error}</div>;
  if (!advisories) return <Plotting label="reading AFFECTS edges and every lockfile that pinned them" />;

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Known vulnerabilities, in both tenses</h2>
        <p className="sub">
          {advisories.length} real OSV.dev records. <b>Now</b> counts repositories whose current
          lockfile pins an affected version. <b>Then</b> counts repositories that pinned one in a
          superseded lockfile and have since upgraded away — clean today, and they shipped it.
        </p>

        {liveCount === 0 && everShipped.length > 0 && (
          <div className="explainer">
            <b className="ok">No advisory affects a current lockfile.</b> Every one of these was
            upgraded away from — which is what a scanner would tell you, and it would stop there.
            But <b className="warn">{everShipped.length}</b> repositories shipped an affected version
            at some point: {everShipped.join(', ')}. The evidence is in lockfiles that no longer
            exist on disk, so nothing that reads the working tree can find it.
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <label className="toggle">
            <input
              type="checkbox"
              checked={onlyReaching}
              onChange={(event) => setOnlyReaching(event.target.checked)}
            />
            only advisories that reach this organisation
          </label>
          <div className="muted" style={{ maxWidth: '58ch', marginTop: 4 }}>
            {advisories.length - sorted.length} of {advisories.length} affect packages nobody here
            has ever pinned.
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Advisories</h2>
        {sorted.length === 0 && <div className="empty">Nothing in this filter.</div>}
        {sorted.length > 0 && (
          <table className="advisory-table">
            <thead>
              <tr>
                <th>advisory</th>
                <th>severity</th>
                <th>now</th>
                <th>then</th>
                <th>disclosed</th>
                <th>summary</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((advisory) => (
                <tr key={advisory.id}>
                  <td className="mono">{advisory.id}</td>
                  <td>
                    <span className={`pill ${severityClass(advisory.severity)}`}>
                      {advisory.severity}
                    </span>
                  </td>
                  <td className={advisory.exposedRepos.length > 0 ? 'mono danger' : 'mono muted'}>
                    {advisory.exposedRepos.length}
                  </td>
                  <td className={advisory.historicalRepos.length > 0 ? 'mono warn' : 'mono muted'}>
                    {advisory.historicalRepos.length}
                  </td>
                  <td className="mono muted">{fmtDate(advisory.published).slice(0, 10)}</td>
                  <td>
                    {/* max-width on a <td> is ignored unless the table is
                        table-layout: fixed, so the measure is capped on a
                        wrapper instead. */}
                    <div className="summary-cell">
                      {advisory.summary}
                      {advisory.exposedRepos.length > 0 && (
                        <div className="reason danger">
                          exposed now: {advisory.exposedRepos.join(', ')}
                        </div>
                      )}
                      {advisory.historicalRepos.length > 0 && (
                        <div className="reason warn">
                          shipped it: {advisory.historicalRepos.join(', ')}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Conditions
          entries={[
            ['elapsed', fmtMs(elapsed)],
            ['source', 'OSV.dev, via AFFECTS edges'],
            ['records', advisories.length],
          ]}
        />
      </div>
    </div>
  );
}
