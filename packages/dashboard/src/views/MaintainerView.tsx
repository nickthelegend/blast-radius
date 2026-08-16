import { useEffect, useMemo, useRef, useState } from 'react';

import { api, fmtMs, type MaintainerReport } from '../lib/api.js';
import { Plotting } from '../components/Plotting.js';

/**
 * Radial view of the maintainer web: the package at the centre, the accounts
 * that can publish to it in an inner ring, and every other package those
 * accounts can reach on the outside. Packages the org already depends on are
 * drawn in red — those are the ones where a stolen credential reaches you.
 */
function RadialWeb({ report }: { report: MaintainerReport }): JSX.Element {
  const ref = useRef<SVGSVGElement | null>(null);
  const size = 460;
  const centre = size / 2;

  const layout = useMemo(() => {
    const neighbors = report.neighbors.slice(0, 40);
    const maintainers = report.maintainers.slice(0, 10);

    const maintainerPoints = maintainers.map((maintainer, index) => {
      const angle = (index / Math.max(1, maintainers.length)) * Math.PI * 2 - Math.PI / 2;
      return {
        ...maintainer,
        x: centre + Math.cos(angle) * 96,
        y: centre + Math.sin(angle) * 96,
        angle,
      };
    });

    const byMaintainer = new Map(maintainerPoints.map((point) => [point.username, point]));
    const neighborPoints = neighbors.map((neighbor, index) => {
      const angle = (index / Math.max(1, neighbors.length)) * Math.PI * 2 - Math.PI / 2;
      return {
        ...neighbor,
        x: centre + Math.cos(angle) * 190,
        y: centre + Math.sin(angle) * 190,
        via: neighbor.sharedMaintainers.map((name) => byMaintainer.get(name)).filter(Boolean),
      };
    });

    return { maintainerPoints, neighborPoints };
  }, [report, centre]);

  return (
    <svg ref={ref} viewBox={`0 0 ${size} ${size}`} style={{ width: '100%', maxWidth: 560 }}>
      {layout.neighborPoints.map((neighbor) =>
        neighbor.via.map((maintainer) => (
          <line
            key={`${neighbor.packageKey}-${maintainer!.username}`}
            x1={maintainer!.x}
            y1={maintainer!.y}
            x2={neighbor.x}
            y2={neighbor.y}
            stroke={neighbor.isOrgDependency ? 'rgba(255,92,108,0.45)' : 'rgba(70,81,107,0.35)'}
            strokeWidth={1}
          />
        )),
      )}
      {layout.maintainerPoints.map((maintainer) => (
        <line
          key={`c-${maintainer.username}`}
          x1={centre}
          y1={centre}
          x2={maintainer.x}
          y2={maintainer.y}
          stroke="rgba(255,180,84,0.5)"
          strokeWidth={1.5}
        />
      ))}

      {layout.neighborPoints.map((neighbor) => (
        <g key={neighbor.packageKey}>
          <circle
            cx={neighbor.x}
            cy={neighbor.y}
            r={neighbor.isOrgDependency ? 6 : 3.5}
            fill={neighbor.isOrgDependency ? '#ff6a45' : '#93b0c2'}
          />
          <title>
            {neighbor.packageName}
            {neighbor.isOrgDependency ? ' (you depend on this)' : ''}
          </title>
        </g>
      ))}

      {layout.maintainerPoints.map((maintainer) => (
        <g key={maintainer.username}>
          <circle cx={maintainer.x} cy={maintainer.y} r={7} fill="#e3ac57" />
          <text
            x={maintainer.x}
            y={maintainer.y - 12}
            fill="#ece6da"
            fontSize={11}
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
          >
            {maintainer.username}
          </text>
        </g>
      ))}

      <circle cx={centre} cy={centre} r={13} fill="#ff6a45" />
      <text
        x={centre}
        y={centre + 30}
        fill="#ece6da"
        fontSize={12}
        textAnchor="middle"
        fontFamily="ui-monospace, monospace"
      >
        {report.package.name}
      </text>
    </svg>
  );
}

export function MaintainerView({ packageKey }: { packageKey: string }): JSX.Element {
  const [report, setReport] = useState<MaintainerReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!packageKey) return;
    let cancelled = false;
    setError(null);
    api
      .maintainers(packageKey)
      .then((result) => {
        if (!cancelled) setReport(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [packageKey]);

  if (error) return <div className="error">{error}</div>;
  if (!report) return <Plotting label="walking MAINTAINS edges — algo.SSpaths" />;

  const riskClass =
    report.riskLevel === 'HIGH' ? 'danger' : report.riskLevel === 'MEDIUM' ? 'warn' : 'ok';

  return (
    <div className="grid-2">
      <div className="panel">
        <h2>Maintainer web — {report.package.name}</h2>
        <p className="sub">
          A compromised publish credential compromises every package it can publish to. This is that
          set, found by walking <span className="mono">MAINTAINS</span> edges out and back in one{' '}
          <span className="mono">algo.SSpaths</span> call.
        </p>
        <RadialWeb report={report} />
        <div className="row" style={{ marginTop: 10 }}>
          <span className={`pill ${riskClass}`}>RISK: {report.riskLevel}</span>
          <span className="muted">{report.riskReason}</span>
        </div>
        <div className="muted mono" style={{ marginTop: 6 }}>
          {fmtMs(report.elapsedMs)}
        </div>
      </div>

      <div className="panel">
        <h2>Packages reachable from the same accounts</h2>
        <p className="sub">
          Red rows are packages your organization already depends on — a stolen credential for a
          shared maintainer reaches your build from two directions at once.
        </p>
        {report.neighbors.length === 0 && (
          <div className="empty">
            No other package in the graph shares a maintainer with this one.
          </div>
        )}
        {report.neighbors.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>package</th>
                <th>shared maintainer</th>
                <th>weekly downloads</th>
              </tr>
            </thead>
            <tbody>
              {report.neighbors.slice(0, 40).map((neighbor) => (
                <tr key={neighbor.packageKey}>
                  <td className={neighbor.isOrgDependency ? 'danger mono' : 'mono'}>
                    {neighbor.packageName}
                    {neighbor.isOrgDependency && (
                      <span className="pill danger" style={{ marginLeft: 6 }}>
                        you depend on this
                      </span>
                    )}
                  </td>
                  <td className="muted mono">{neighbor.sharedMaintainers.join(', ')}</td>
                  <td className="mono muted">{neighbor.downloads.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
