import { useEffect, useState } from 'react';

import { api, fmtDate, fmtMs, type TyposquatFinding } from '../lib/api.js';

const VERDICT_CLASS: Record<TyposquatFinding['verdict'], string> = {
  SUSPICIOUS: 'danger',
  WATCH: 'warn',
  LIKELY_LEGITIMATE: 'ok',
};

export function TyposquatView(): JSX.Element {
  const [findings, setFindings] = useState<TyposquatFinding[] | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [filter, setFilter] = useState<'ALL' | TyposquatFinding['verdict']>('SUSPICIOUS');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .typosquats()
      .then((result) => {
        if (cancelled) return;
        setFindings(result.findings);
        setElapsed(result.elapsedMs);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!findings) return <div className="empty">loading…</div>;

  const counts = {
    ALL: findings.length,
    SUSPICIOUS: findings.filter((finding) => finding.verdict === 'SUSPICIOUS').length,
    WATCH: findings.filter((finding) => finding.verdict === 'WATCH').length,
    LIKELY_LEGITIMATE: findings.filter((finding) => finding.verdict === 'LIKELY_LEGITIMATE').length,
  };
  const shown = filter === 'ALL' ? findings : findings.filter((f) => f.verdict === filter);

  return (
    <div className="panel">
      <h2>Typosquat proximity</h2>
      <p className="sub">
        Real packages on the registry whose names sit close to your own dependencies. Proximity is
        stored as <span className="mono">NAME_SIMILAR_TO</span> edges; the verdict combines the kind
        of edit with the candidate&apos;s age and download volume — <i>preact</i> is one edit from{' '}
        <i>react</i> and entirely legitimate, so distance alone decides nothing.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        {(['SUSPICIOUS', 'WATCH', 'LIKELY_LEGITIMATE', 'ALL'] as const).map((value) => (
          <button
            key={value}
            className="action"
            style={{
              background: filter === value ? 'var(--accent)' : 'var(--panel-2)',
              color: filter === value ? '#07131f' : 'var(--muted)',
            }}
            onClick={() => setFilter(value)}
          >
            {value.replace('_', ' ')} ({counts[value]})
          </button>
        ))}
        <span className="muted mono" style={{ marginLeft: 'auto' }}>
          {fmtMs(elapsed)}
        </span>
      </div>

      {shown.length === 0 && <div className="empty">Nothing in this category.</div>}
      {shown.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>your dependency</th>
              <th>near-name package</th>
              <th>distance</th>
              <th>weekly downloads</th>
              <th>first published</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 120).map((finding) => (
              <tr key={`${finding.trustedKey}-${finding.candidateKey}`}>
                <td className="mono">{finding.trustedName}</td>
                <td className="mono danger">{finding.candidateName}</td>
                <td className="mono">{finding.distance}</td>
                <td className="mono">{finding.candidateDownloads.toLocaleString()}</td>
                <td className="mono muted">
                  {finding.candidateCreatedAt ? fmtDate(finding.candidateCreatedAt).slice(0, 10) : '—'}
                </td>
                <td>
                  <span className={`pill ${VERDICT_CLASS[finding.verdict]}`}>{finding.verdict}</span>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                    {finding.reason}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
