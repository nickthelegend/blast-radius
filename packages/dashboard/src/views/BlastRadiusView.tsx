import { useEffect, useMemo, useState } from 'react';

import { ForceGraph } from '../components/ForceGraph.js';
import { Conditions } from '../components/Conditions.js';
import { QueryLink } from '../components/QueryLink.js';
import { Plotting } from '../components/Plotting.js';
import {
  api,
  fmtDate,
  fmtMs,
  type BlastRadiusReport,
  type ExposedRepo,
  type GraphResponse,
} from '../lib/api.js';

export function Chain({ chain }: { chain: ExposedRepo['chain'] }): JSX.Element {
  return (
    <span className="chain">
      {chain.map((link, index) => (
        <span key={`${link.key}-${index}`}>
          {index > 0 && <span className="sep"> → </span>}
          {index === chain.length - 1 ? <b className="danger">{link.label}</b> : <b>{link.label}</b>}
        </span>
      ))}
    </span>
  );
}

export function BlastRadiusView({
  versionKey,
  repos,
  onShowQuery,
}: {
  versionKey: string;
  repos: Array<{ key: string; name: string }>;
  onShowQuery: (cypher: string) => void;
}): JSX.Element {
  const [report, setReport] = useState<BlastRadiusReport | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [verified, setVerified] = useState(false);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ExposedRepo | null>(null);

  useEffect(() => {
    if (!versionKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.exposure(versionKey, { verified, repos: selectedRepos }),
      api.graph(versionKey, verified),
    ])
      .then(([exposure, graphData]) => {
        if (cancelled) return;
        setReport(exposure);
        setGraph(graphData);
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
  }, [versionKey, verified, selectedRepos]);

  // Light up every node on an exposed repo's chain.
  const highlight = useMemo(() => {
    if (!graph || !report) return new Set<number>();
    const names = new Set(
      (selected ? [selected] : report.exposedRepos).map((exposure) => exposure.repoName),
    );
    const ids = new Set<number>();
    for (const node of graph.nodes) {
      if (node.label === 'Repo' && names.has(node.name)) ids.add(node.id);
    }
    return ids;
  }, [graph, report, selected]);

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={verified}
              onChange={(event) => setVerified(event.target.checked)}
            />
            verified read <span className="muted">(strong consistency, refreshed snapshot)</span>
          </label>
          <select
            value={selectedRepos.length === 0 ? '' : 'subset'}
            onChange={(event) =>
              setSelectedRepos(
                event.target.value === '' ? [] : repos.slice(0, 4).map((repo) => repo.key),
              )
            }
          >
            <option value="">all repos (algo.SSpaths)</option>
            <option value="subset">
              first 4 repos in one round trip (algo.MSpaths)
            </option>
          </select>
        </div>
        {report && (
          <Conditions
            entries={[
              ['procedure', report.procedure],
              ['elapsed', fmtMs(report.elapsedMs)],
              ['paths', report.totalPaths.toLocaleString()],
              ['max depth', report.maxDepthUsed],
              // Toggling "verified read" has to be visible in the result, or the
              // control is asking the reader to take the change on faith.
              ['consistency', report.consistency],
              ['read epoch', report.readEpoch],
            ]}
          />
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {report?.truncated && (
        <div className="error" style={{ marginBottom: 16 }}>
          The traversal returned exactly its path budget ({report.pathCountUsed}); this report may be
          incomplete. Raise BLAST_PATH_COUNT.
        </div>
      )}

      <div className="grid-2">
        <div className="panel">
          <h2>Currently exposed</h2>
          <p className="sub">
            Repos whose <b>current</b> lockfile resolves this exact version. Click a row to isolate
            its path in the graph.
          </p>
          {loading && !report && <Plotting label="running the traversal — algo.SSpaths" rows={5} />}
          {report && report.exposedRepos.length === 0 && (
            <div className="empty">No current lockfile resolves this version.</div>
          )}
          {report && report.exposedRepos.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>repo</th>
                  <th>depth</th>
                  <th>dependency chain</th>
                </tr>
              </thead>
              <tbody>
                {report.exposedRepos.map((exposure) => (
                  <tr
                    key={exposure.repoKey}
                    onClick={() => setSelected(selected === exposure ? null : exposure)}
                    className={selected === exposure ? 'row-selected' : undefined}
                    style={{ cursor: 'pointer' }}
                  >
                    <td className="danger mono">{exposure.repoName}</td>
                    <td className="mono">{exposure.depth}</td>
                    <td>
                      <Chain chain={exposure.chain} />
                      {exposure.direct && <span className="pill warn" style={{ marginLeft: 6 }}>direct</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <h2>Exposed only through a superseded lockfile</h2>
          <p className="sub">
            Not live-exposed — they upgraded. Whether they <i>were</i> exposed during the incident is
            the Time Machine's question.
          </p>
          {report && report.historicallyExposedRepos.length === 0 && (
            <div className="empty">None.</div>
          )}
          {report && report.historicallyExposedRepos.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>repo</th>
                  <th>depth</th>
                  <th>lockfile captured</th>
                </tr>
              </thead>
              <tbody>
                {report.historicallyExposedRepos.map((exposure) => (
                  <tr key={exposure.repoKey}>
                    <td className="mono">{exposure.repoName}</td>
                    <td className="mono">{exposure.depth}</td>
                    <td className="mono muted">{fmtDate(exposure.snapshotCapturedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2>Exposure graph</h2>
        <p className="sub">
          Every node and edge here came back from a single <span className="mono">algo.SSpaths</span>{' '}
          call walking <span className="mono">RESOLVED_TO</span>,{' '}
          <span className="mono">RESOLVED_DIRECT</span> and{' '}
          <span className="mono">HAS_SNAPSHOT</span> backwards from the compromised version.
        </p>
        {graph && graph.nodes.length > 0 ? (
          <>
            <ForceGraph
              nodes={graph.nodes}
              links={graph.links}
              sourceId={graph.source.id}
              highlight={highlight}
            />
            <QueryLink cypher={report?.cypher} onOpen={onShowQuery} />
          </>
        ) : (
          <div className="empty">nothing reachable</div>
        )}
      </div>
    </div>
  );
}
