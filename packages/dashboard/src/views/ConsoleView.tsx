import { useCallback, useEffect, useRef, useState } from 'react';

import { api, fmtMs, type CypherResult } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';

/**
 * The Cypher console.
 *
 * Every other view asserts that HydraDB is doing the work. This one lets you
 * check. It ships the exact queries the product runs as presets, so a reader
 * can execute the blast-radius traversal themselves and see the same numbers
 * the report shows — and edit it to see what changes.
 *
 * Read-only by design: the server refuses mutations, because a browser tab is
 * the wrong place to write to the graph.
 */

interface Preset {
  label: string;
  note: string;
  query: string;
}

const PRESETS: Preset[] = [
  {
    label: 'Blast radius (algo.SSpaths)',
    note: 'the flagship traversal — walks three edge types backwards from the compromised version',
    query: `CALL algo.SSpaths({sourceNode: $SEED_ID, relTypes: ['RESOLVED_TO', 'RESOLVED_DIRECT', 'HAS_SNAPSHOT'],
                  relDirection: 'incoming', maxLen: 10, pathCount: 20000, resultLimit: 20000})
  YIELD path RETURN path`,
  },
  {
    label: 'Time Machine window',
    note: 'the query a flat scanner cannot express — inclusive integer range over captured_at',
    query: `MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $SEED_ID})
WHERE s.captured_at >= $WINDOW_FROM AND s.captured_at <= $WINDOW_TO
RETURN s.repo_name AS repo, s.captured_at AS captured, s.is_current AS still_current
ORDER BY captured`,
  },
  {
    label: 'Maintainer web (SSpaths, both directions)',
    note: 'Package <- Maintainer -> Package in one call',
    query: `CALL algo.SSpaths({sourceNode: $PACKAGE_ID, relTypes: ['MAINTAINS'], relDirection: 'both',
                  maxLen: 2, pathCount: 5000, resultLimit: 5000})
  YIELD path RETURN path`,
  },
  {
    label: 'Advisories by reach',
    note: 'real OSV records joined to the versions they affect',
    query: `MATCH (a:Advisory)-[:AFFECTS]->(v:Version)
RETURN a.key AS advisory, a.severity AS severity, count(*) AS affected_versions
ORDER BY affected_versions DESC LIMIT 10`,
  },
  {
    label: 'Deepest dependency chains',
    note: 'aggregate over the resolution graph',
    query: `MATCH (a:Version)-[:RESOLVED_TO]->(b:Version)
RETURN b.package_name AS package, count(*) AS dependents
ORDER BY dependents DESC LIMIT 12`,
  },
  {
    label: 'Lockfiles that ever pinned the incident version',
    note: 'the whole history, not just the current state',
    query: `MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $SEED_ID})
RETURN s.repo_name AS repo, s.captured_at AS captured, s.superseded_at AS superseded
ORDER BY captured`,
  },
  {
    label: 'Graph inventory',
    note: 'what is actually loaded',
    query: `MATCH (v:Version) RETURN count(*) AS versions`,
  },
];

export function ConsoleView({
  seedVersionKey,
  initialQuery,
}: {
  seedVersionKey: string;
  initialQuery?: string;
}): JSX.Element {
  const [query, setQuery] = useState(initialQuery ?? PRESETS[0]!.query);
  const [result, setResult] = useState<CypherResult | null>(null);
  const [running, setRunning] = useState(false);
  const [consistency, setConsistency] = useState<'causal' | 'strong'>('causal');
  const [transport, setTransport] = useState<'http' | 'bolt'>('http');
  const [seedId, setSeedId] = useState<number | null>(null);
  const [packageId, setPackageId] = useState<number | null>(null);
  /** The selected version's own compromise window, so the Time Machine preset
   *  cannot drift away from the data the way a hardcoded pair of epochs did. */
  const [window, setWindow] = useState<{ from: number; to: number } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // Resolve the ids the presets reference, so a preset is runnable as-is.
  useEffect(() => {
    if (!seedVersionKey) return;
    api
      .cypher(
        `MATCH (v:Version) WHERE v.key = '${seedVersionKey.replace(/'/g, "\\'")}' RETURN v.id AS id LIMIT 1`,
      )
      .then((r) => {
        const id = r.rows[0]?.id;
        if (typeof id === 'number') setSeedId(id);
      })
      .catch(() => undefined);

    api
      .cypher(
        `MATCH (v:Version) WHERE v.key = '${seedVersionKey.replace(/'/g, "\\'")}' ` +
          'RETURN v.compromised_from AS f, v.compromised_to AS t LIMIT 1',
      )
      .then((r) => {
        const f = r.rows[0]?.f;
        const t = r.rows[0]?.t;
        if (typeof f === 'number' && typeof t === 'number' && f > 0) setWindow({ from: f, to: t });
      })
      .catch(() => undefined);

    const pkg = seedVersionKey.slice(0, seedVersionKey.lastIndexOf('@'));
    api
      .cypher(`MATCH (p:Package) WHERE p.key = '${pkg.replace(/'/g, "\\'")}' RETURN p.id AS id LIMIT 1`)
      .then((r) => {
        const id = r.rows[0]?.id;
        if (typeof id === 'number') setPackageId(id);
      })
      .catch(() => undefined);
  }, [seedVersionKey]);

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);

  const substitute = useCallback(
    (text: string) =>
      text
        .replace(/\$SEED_ID/g, seedId === null ? '0' : String(seedId))
        .replace(/\$PACKAGE_ID/g, packageId === null ? '0' : String(packageId))
        .replace(/\$WINDOW_FROM/g, window === null ? '0' : String(window.from))
        .replace(/\$WINDOW_TO/g, window === null ? '0' : String(window.to)),
    [seedId, packageId, window],
  );

  const run = useCallback(async () => {
    setRunning(true);
    try {
      setResult(await api.cypher(substitute(query), consistency, transport));
    } catch (error) {
      setResult({
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        elapsedMs: 0,
        wallMs: 0,
        queryError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }, [query, consistency, transport, substitute]);

  // ⌘/Ctrl+Enter runs, the way every SQL console works.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void run();
    }
  };

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Cypher console</h2>
        <p className="sub">
          Every number in this dashboard comes from a query like these. Run them yourself —{' '}
          <span className="mono">$SEED_ID</span>, <span className="mono">$PACKAGE_ID</span>,{' '}
          <span className="mono">$WINDOW_FROM</span> and <span className="mono">$WINDOW_TO</span>{' '}
          are substituted from the selected version. Read-only: the server refuses mutations.
        </p>

        <div className="row" style={{ marginBottom: 10, gap: 6 }}>
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              className="preset"
              title={preset.note}

              onClick={() => {
                setQuery(preset.query);
                areaRef.current?.focus();
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <textarea
          ref={areaRef}
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          rows={8}
          className="mono"
          style={{
            width: '100%',
            background: 'var(--well)',
            color: 'var(--ink)',
            border: '1px solid var(--rule)',
            borderRadius: 0,
            padding: 12,
            lineHeight: 1.6,
            resize: 'vertical',
          }}
        />

        <div className="row" style={{ marginTop: 10 }}>
          <button className="action" onClick={() => void run()} disabled={running}>
            {running ? 'running…' : 'run  ⌘↵'}
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={consistency === 'strong'}
              onChange={(event) => setConsistency(event.target.checked ? 'strong' : 'causal')}
            />
            strong consistency
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={transport === 'bolt'}
              onChange={(event) => setTransport(event.target.checked ? 'bolt' : 'http')}
            />
            over Bolt
            <span className="muted">
              (a stock neo4j-driver against the same engine — the compatibility claim, checkable)
            </span>
          </label>
          <button
            className="action"
            style={{ background: 'var(--sheet-2)', color: 'var(--ink-2)' }}
            onClick={() => void copyText(substitute(query))}
          >
            copy query
          </button>
          {result && !result.queryError && (
            <span className="muted mono" style={{ marginLeft: 'auto' }}>
              {result.rowCount} row{result.rowCount === 1 ? '' : 's'} · engine{' '}
              {fmtMs(result.elapsedMs)} · round trip {fmtMs(result.wallMs)}
              {result.readEpoch !== null && result.readEpoch !== undefined
                ? ` · epoch ${result.readEpoch}`
                : ''}
              {result.transport === 'bolt'
                ? ` · over Bolt${result.server ? ` (${result.server})` : ''}`
                : ''}
            </span>
          )}
        </div>
      </div>

      {result?.queryError && (
        <div className="error">
          <b>The engine rejected this query.</b>
          <div style={{ marginTop: 6 }}>{result.queryError}</div>
          <div className="muted" style={{ marginTop: 8 }}>
            HydraDB implements a deliberate subset of OpenCypher and rejects the rest at parse time
            rather than planning something slow. That is the real error message, unmodified.
          </div>
        </div>
      )}

      {result && !result.queryError && (
        <div className="panel">
          <h2>Result</h2>
          {result.rows.length === 0 ? (
            <div className="empty">No rows.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    {result.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index} className="row-in" style={{ animationDelay: `${Math.min(index, 20) * 12}ms` }}>
                      {result.columns.map((column) => (
                        <td key={column} className="mono" >
                          {formatCell(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.truncated && (
            <div className="explainer">
              Showing the first {result.rows.length} of {result.rowCount} rows.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // Epoch-millisecond columns are unreadable as raw integers.
    if (value > 1_500_000_000_000 && value < 2_500_000_000_000) {
      return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
    return value.toLocaleString();
  }
  return String(value);
}
