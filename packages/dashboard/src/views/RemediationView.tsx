import { useEffect, useState } from 'react';

import { QueryLink } from '../components/QueryLink.js';
import { api, fmtMs, type RemediationPlan } from '../lib/api.js';

/**
 * Remediation view — the "so what do I do" half of an incident.
 *
 * Every candidate version of every offending dependency is tested against the
 * graph in one `algo.MSpaths` call per package, so the recommendation is
 * derived from the actual resolution graph rather than from a version-number
 * heuristic.
 */
export function RemediationView({
  versionKey,
  onShowQuery,
}: {
  versionKey: string;
  onShowQuery: (cypher: string) => void;
}): JSX.Element {
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!versionKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .remediation(versionKey)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [versionKey]);

  if (error) return <div className="error">{error}</div>;
  if (loading && !plan) return <div className="empty">testing candidate versions against the graph…</div>;
  if (!plan) return <div className="empty">no plan</div>;

  if (plan.fixes.length === 0) {
    return (
      <div className="panel">
        <h2>Remediation</h2>
        <div className="empty ok">Nothing to do — no repository currently resolves this version.</div>
      </div>
    );
  }

  const rollbacks = plan.fixes.filter((fix) => fix.direction === 'rollback').length;

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Do this</h2>
        <p className="sub">
          The minimal dependency change that stops each repository resolving{' '}
          <span className="mono danger">{plan.source.key}</span>. {plan.candidatesTested} candidate
          versions were tested against the resolution graph.
        </p>
        <table>
          <thead>
            <tr>
              <th>change</th>
              <th>package</th>
              <th>from</th>
              <th>to</th>
              <th>clears</th>
            </tr>
          </thead>
          <tbody>
            {plan.distinctChanges.map((change) => (
              <tr key={`${change.packageName}@${change.to}`}>
                <td>
                  <span className={`pill ${change.direction === 'rollback' ? 'warn' : 'ok'}`}>
                    {change.direction === 'rollback' ? 'roll back' : 'upgrade'}
                  </span>
                </td>
                <td className="mono">{change.packageName}</td>
                <td className="mono muted">{change.from.join(', ')}</td>
                <td className="mono ok">{change.to}</td>
                <td className="muted" style={{ fontSize: 12.5 }}>
                  {change.repos.join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Per repository</h2>
        <table>
          <thead>
            <tr>
              <th>repo</th>
              <th>dependency to change</th>
              <th>why it is exposed</th>
            </tr>
          </thead>
          <tbody>
            {plan.fixes.map((fix) => (
              <tr key={fix.repoKey}>
                <td className="mono danger">{fix.repoName}</td>
                <td className="mono">
                  {fix.targetVersion === null ? (
                    <span className="pill danger">no safe version</span>
                  ) : (
                    <>
                      {fix.packageName} <span className="danger">{fix.currentVersion}</span>
                      {fix.direction === 'rollback' ? (
                        <span className="warn"> ↓ </span>
                      ) : (
                        <span className="ok"> ↑ </span>
                      )}
                      <span className="ok">{fix.targetVersion}</span>
                      {fix.isMajorBump && (
                        <span className="pill warn" style={{ marginLeft: 6 }}>
                          major
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="chain">{fix.chainText}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {rollbacks > 0 && (
          <div className="explainer">
            <b className="warn">{rollbacks}</b> of these are <b>rollbacks</b>, not upgrades — no
            newer release in the graph avoids the compromised version. Rolling back is a normal
            response to a live compromise, but it is labelled as such rather than dressed up as an
            upgrade.
          </div>
        )}

        <div className="muted mono" style={{ fontSize: 12, marginTop: 10 }}>
          {fmtMs(plan.elapsedMs)} · algo.MSpaths
        </div>
        <QueryLink cypher={plan.cypher} onOpen={onShowQuery} />
      </div>
    </div>
  );
}
