import { useState } from 'react';

import { copyText } from '../lib/clipboard.js';

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
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (!cypher) return null;

  return (
    <span className="row" style={{ gap: 10, marginTop: 8 }}>
      <button
        className="action"
        style={{ background: 'var(--sheet-2)', color: 'var(--ink-2)', padding: '5px 10px' }}
        onClick={() => onOpen(cypher)}
        title="Open this query in the Cypher console"
      >
        show the query
      </button>
      <span
        className={
          'copyable muted mono' +
          (copyState === 'copied' ? ' copied' : '') +
          (copyState === 'failed' ? ' copy-failed' : '')
        }
        onClick={() => {
          // Only claim success once the write has actually resolved.
          void copyText(cypher).then((ok) => {
            setCopyState(ok ? 'copied' : 'failed');
            setTimeout(() => setCopyState('idle'), 1600);
          });
        }}
      >
        {copyState === 'idle' ? 'copy' : copyState === 'failed' ? 'copy blocked' : ''}
      </span>
    </span>
  );
}
