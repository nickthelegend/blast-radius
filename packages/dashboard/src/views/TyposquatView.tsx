import { useEffect, useState } from 'react';

import { Conditions } from '../components/Conditions.js';
import { api, fmtDate, fmtMs, type TyposquatFinding } from '../lib/api.js';
import { Plotting } from '../components/Plotting.js';

const VERDICT_CLASS: Record<TyposquatFinding['verdict'], string> = {
  SUSPICIOUS: 'danger',
  WATCH: 'warn',
  LIKELY_LEGITIMATE: 'ok',
};

/** The key's bands, including the unfiltered total which has no verdict of its own. */
const BAND_CLASS: Record<'ALL' | TyposquatFinding['verdict'], string> = {
  ...VERDICT_CLASS,
  ALL: 'all',
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
  if (!findings) return <Plotting label="reading NAME_SIMILAR_TO edges" />;

  const counts = {
    ALL: findings.length,
    SUSPICIOUS: findings.filter((finding) => finding.verdict === 'SUSPICIOUS').length,
    WATCH: findings.filter((finding) => finding.verdict === 'WATCH').length,
    LIKELY_LEGITIMATE: findings.filter((finding) => finding.verdict === 'LIKELY_LEGITIMATE').length,
  };
  const shown = filter === 'ALL' ? findings : findings.filter((f) => f.verdict === filter);
  // Rendering every row of a 200-finding list is slow and unreadable, but a cap
  // that is not stated is a silent truncation — the reader would have no way to
  // know findings were withheld. So the cap is applied AND reported.
  const RENDER_LIMIT = 120;
  const visible = shown.slice(0, RENDER_LIMIT);
  const withheld = shown.length - visible.length;

  return (
    <div className="panel">
      <h2>Typosquat proximity</h2>
      <p className="sub">
        Real packages on the registry whose names sit close to your own dependencies. Proximity is
        stored as <span className="mono">NAME_SIMILAR_TO</span> edges; the verdict combines the kind
        of edit with the candidate&apos;s age and download volume — <i>preact</i> is one edit from{' '}
        <i>react</i> and entirely legitimate, so distance alone decides nothing.
      </p>

      <div className="verdict-key">
        {(['SUSPICIOUS', 'WATCH', 'LIKELY_LEGITIMATE', 'ALL'] as const).map((value) => (
          <button
            key={value}
            className={`key-band${filter === value ? ' active' : ''} ${BAND_CLASS[value]}`}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            <span className="name">{value.replace('_', ' ')}</span>
            <span className="count">{counts[value]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 && <div className="empty">Nothing in this category.</div>}
      {shown.length > 0 && (
        <table className="typosquat-table">
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
            {visible.map((finding) => (
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
                  <div className="reason muted">{finding.reason}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {withheld > 0 && (
        <div className="explainer">
          Showing <b>{visible.length}</b> of <b>{shown.length}</b> findings.{' '}
          {withheld} more are not rendered — narrow the filter to see them, or use{' '}
          <span className="mono">blastradius typosquats --all</span>.
        </div>
      )}

      <Conditions
        entries={[
          ['elapsed', fmtMs(elapsed)],
          ['source', 'NAME_SIMILAR_TO edges'],
          ['findings', findings?.length ?? 0],
        ]}
      />
    </div>
  );
}
