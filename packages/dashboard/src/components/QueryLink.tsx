import { useState } from 'react';

/**
 * "Show the query" — provenance for a panel.
 *
 * Every panel in this dashboard is the rendering of one Cypher query. This puts
 * that query one click away, which is the difference between claiming the graph
 * engine does the work and letting the reader confirm it.
 */
export function QueryLink({
  cypher,
  onOpen,
}: {
  cypher?: string;
  onOpen: (cypher: string) => void;
}): JSX.Element | null {
  const [copied, setCopied] = useState(false);
  if (!cypher) return null;

  return (
    <span className="row" style={{ gap: 10, marginTop: 8 }}>
      <button
        className="action"
        style={{ background: 'var(--panel-2)', color: 'var(--muted)', fontSize: 11.5, padding: '5px 10px' }}
        onClick={() => onOpen(cypher)}
        title="Open this query in the Cypher console"
      >
        show the query
      </button>
      <span
        className={`copyable muted mono${copied ? ' copied' : ''}`}
        style={{ fontSize: 11.5 }}
        onClick={() => {
          void navigator.clipboard?.writeText(cypher);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? '' : 'copy'}
      </span>
    </span>
  );
}
