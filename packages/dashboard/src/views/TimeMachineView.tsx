import { useEffect, useMemo, useState } from 'react';

import { Conditions } from '../components/Conditions.js';
import { QueryLink } from '../components/QueryLink.js';
import { api, fmtDate, fmtMs, fmtTime, type TimeMachineResponse } from '../lib/api.js';
import { Plotting } from '../components/Plotting.js';

/**
 * The Time Machine view.
 *
 * The layout is deliberately a side-by-side: "exposed now" and "exposed during
 * the window" are different questions with different answers, and the set that
 * appears in one column but not the other is the entire argument for keeping
 * lockfile history in a graph at all.
 */
export function TimeMachineView({
  versionKey,
  onShowQuery,
}: {
  versionKey: string;
  onShowQuery: (cypher: string) => void;
}): JSX.Element {
  const [data, setData] = useState<TimeMachineResponse | null>(null);
  const [verified, setVerified] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [asOf, setAsOf] = useState<string[] | null>(null);

  useEffect(() => {
    if (!versionKey) return;
    let cancelled = false;
    setError(null);
    api
      .timeMachine(versionKey, { verified })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [versionKey, verified]);

  const bounds = useMemo(() => {
    if (!data) return null;
    const times = data.allExposures.map((exposure) => exposure.capturedAt).filter(Boolean);
    const min = Math.min(...times, data.timeMachine.windowFrom);
    const max = Math.max(...times, data.timeMachine.windowTo);
    const pad = (max - min) * 0.04 || 60_000;
    return { min: min - pad, max: max + pad };
  }, [data]);

  useEffect(() => {
    if (scrub === null || !versionKey) return;
    let cancelled = false;
    api
      .asOf(versionKey, scrub)
      .then((result) => {
        if (!cancelled) setAsOf(result.exposures.map((exposure) => exposure.repoName));
      })
      .catch(() => {
        if (!cancelled) setAsOf(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scrub, versionKey]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <Plotting label="reading lockfile history inside a pinned snapshot" rows={4} />;

  const { timeMachine } = data;
  const duringNames = new Set(timeMachine.duringWindow.map((exposure) => exposure.repoName));
  const nowNames = new Set(data.exposedNow.map((exposure) => exposure.repoName));
  const allNames = [...new Set([...duringNames, ...nowNames])].sort();
  const onlyHistorical = allNames.filter((name) => duringNames.has(name) && !nowNames.has(name));
  const onlyNow = allNames.filter((name) => nowNames.has(name) && !duringNames.has(name));

  const position = (time: number): number => {
    if (!bounds) return 0;
    return ((time - bounds.min) / (bounds.max - bounds.min)) * 100;
  };

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row">
          <div>
            <div className="field-label">compromise window</div>
            <div className="mono window-value">
              {fmtTime(timeMachine.windowFrom)} → {fmtTime(timeMachine.windowTo)}
              <span className="muted" style={{ marginLeft: 10 }}>
                {new Date(timeMachine.windowFrom).toUTCString().slice(0, 16)}
              </span>
            </div>
          </div>
          <label className="toggle" style={{ marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={verified}
              onChange={(event) => setVerified(event.target.checked)}
            />
            verified
            <span className="muted">
              (strong consistency — refreshes from object storage before pinning the snapshot)
            </span>
          </label>
        </div>
        <Conditions
          entries={[
            ['elapsed', fmtMs(timeMachine.elapsedMs)],
            ['consistency', timeMachine.consistency],
            ['read epoch', timeMachine.readEpoch],
          ]}
        />
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Lockfile timeline</h2>
        <p className="sub">
          Every capture that ever pinned this version. The hatched band is the window the malicious
          build was live. Drag to query exposure as of any instant.
        </p>
        <div className="timeline">
          {bounds && (
            <>
              {/* Six minutes inside a six-month axis is a hairline. The band is
                  given a floor width and a drawn bracket so the one interval
                  this whole product exists to talk about is findable on the
                  scale, and the callout states the true duration so the floor
                  never reads as the measurement. */}
              <div
                className="window"
                style={{
                  left: `${position(timeMachine.windowFrom)}%`,
                  width: `max(3px, ${position(timeMachine.windowTo) - position(timeMachine.windowFrom)}%)`,
                }}
              />
              <div
                className={`window-callout${position(timeMachine.windowFrom) > 62 ? ' flip' : ''}`}
                style={{ left: `${position(timeMachine.windowFrom)}%` }}
              >
                <span className="leader" />
                <span className="text">
                  compromise window ·{' '}
                  {Math.round((timeMachine.windowTo - timeMachine.windowFrom) / 60_000)} min
                </span>
              </div>
              {data.allExposures.map((exposure) => {
                const inWindow =
                  exposure.capturedAt >= timeMachine.windowFrom &&
                  exposure.capturedAt <= timeMachine.windowTo;
                return (
                  <div
                    key={exposure.snapshotKey}
                    className="tick"
                    title={`${exposure.repoName} — ${fmtDate(exposure.capturedAt)}`}
                    style={{
                      left: `${position(exposure.capturedAt)}%`,
                      top: exposure.isCurrent ? '32%' : '58%',
                      background: inWindow ? '#ff6a45' : exposure.isCurrent ? '#9dc46f' : '#6f665a',
                    }}
                  />
                );
              })}
              <div className="axis" />
              <div className="axis-label start">
                {new Date(bounds.min).toISOString().slice(0, 10)}
              </div>
              <div className="axis-label end">
                {new Date(bounds.max).toISOString().slice(0, 10)}
              </div>
            </>
          )}
        </div>
        {bounds && (
          <div className="row">
            <input
              type="range"
              min={bounds.min}
              max={bounds.max}
              step={60_000}
              value={scrub ?? bounds.max}
              onChange={(event) => setScrub(Number(event.target.value))}
              style={{ flex: 1 }}
            />
            <span className="mono muted scrub-readout">
              as of {fmtDate(scrub ?? bounds.max)}
            </span>
          </div>
        )}
        {asOf && (
          <div className="explainer">
            <b>{asOf.length}</b> {asOf.length === 1 ? 'repo' : 'repos'} pinned this version at that
            instant{asOf.length > 0 ? `: ${asOf.join(', ')}` : '.'}
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Exposed during the window</h2>
          <p className="sub">
            Lockfiles captured inside {fmtTime(timeMachine.windowFrom)}–
            {fmtTime(timeMachine.windowTo)} that resolved the malicious version. These builds ran it.
          </p>
          {timeMachine.duringWindow.length === 0 && <div className="empty">None.</div>}
          {timeMachine.duringWindow.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>repo</th>
                  <th>captured</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {timeMachine.duringWindow.map((exposure) => (
                  <tr key={exposure.snapshotKey}>
                    <td className="danger mono">{exposure.repoName}</td>
                    <td className="mono">{fmtTime(exposure.capturedAt)}</td>
                    <td>
                      {exposure.isCurrent ? (
                        <span className="pill danger">still pinned</span>
                      ) : (
                        <span className="pill warn">
                          superseded {fmtTime(exposure.supersededAt)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <QueryLink cypher={timeMachine.cypher} onOpen={onShowQuery} />
        </div>

        <div className="panel">
          <h2>Exposed right now</h2>
          <p className="sub">
            What a current-state scanner sees: repos whose live lockfile still resolves this version.
          </p>
          {data.exposedNow.length === 0 && <div className="empty">None.</div>}
          {data.exposedNow.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>repo</th>
                  <th>depth</th>
                  <th>chain</th>
                </tr>
              </thead>
              <tbody>
                {data.exposedNow.map((exposure) => (
                  <tr key={exposure.repoKey}>
                    <td className="danger mono">{exposure.repoName}</td>
                    <td className="mono">{exposure.depth}</td>
                    <td className="chain">{exposure.chainText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2>Why the two columns differ</h2>
        <table>
          <thead>
            <tr>
              <th>repo</th>
              <th>exposed now</th>
              <th>exposed during window</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {allNames.map((name) => {
              const now = nowNames.has(name);
              const during = duringNames.has(name);
              return (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td className={now ? 'danger' : 'ok'}>{now ? 'yes' : 'no'}</td>
                  <td className={during ? 'danger' : 'ok'}>{during ? 'yes' : 'no'}</td>
                  <td className="muted" >
                    {during && !now && 'ran the malicious build, has since upgraded'}
                    {now && !during && 'picked it up after the artifacts were pulled'}
                    {now && during && 'exposed then and now'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {onlyHistorical.length > 0 && (
          <div className="explainer">
            <b className="warn">{onlyHistorical.length}</b>{' '}
            {onlyHistorical.length === 1 ? 'repo is' : 'repos are'} clean today but{' '}
            <b>ran the malicious build</b>: {onlyHistorical.join(', ')}. A scanner that only reads
            current lockfiles reports these as safe — it has no record of what they resolved to at
            09:00. This is the query a flat scanner structurally cannot answer.
          </div>
        )}
        {onlyNow.length > 0 && (
          <div className="explainer">
            <b className="warn">{onlyNow.length}</b> {onlyNow.length === 1 ? 'repo' : 'repos'}{' '}
            picked the version up <b>after</b> the artifacts were pulled: {onlyNow.join(', ')}. Live
            exposure, but not incident exposure — a different remediation priority.
          </div>
        )}
      </div>
    </div>
  );
}
