import { useRef, useState } from 'react';

import { copyText } from '../lib/clipboard.js';

/**
 * Copy a rendered table as Markdown or CSV.
 *
 * The end of an incident query is almost always "paste this into the channel".
 * Retyping a dependency chain out of a screenshot is how the wrong package name
 * ends up in an incident log, so the table hands over its own contents.
 *
 * It reads the DOM rather than taking the data as a prop deliberately: what gets
 * copied is then exactly what is on screen, including the active filter and any
 * truncation — a copy that silently included rows the reader could not see would
 * be worse than no copy at all.
 */
export function CopyTable({
  targetRef,
  caption,
}: {
  targetRef: React.RefObject<HTMLElement>;
  caption?: string;
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'md' | 'csv' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);

  const flash = (next: 'md' | 'csv' | 'failed') => {
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  const extract = (): { head: string[]; rows: string[][] } | null => {
    const table = targetRef.current?.querySelector('table');
    if (!table) return null;
    const head = [...table.querySelectorAll('thead th')].map((cell) =>
      (cell.textContent ?? '').trim(),
    );
    const rows = [...table.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) =>
        // Collapse the internal newlines a wrapped chain or a reason introduces,
        // or one cell becomes several rows in the pasted table.
        (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    );
    return { head, rows };
  };

  const asMarkdown = (): string => {
    const data = extract();
    if (!data) return '';
    const escape = (value: string) => value.replace(/\|/g, '\\|');
    const lines = [
      `| ${data.head.map(escape).join(' | ')} |`,
      `|${data.head.map(() => '---').join('|')}|`,
      ...data.rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
    ];
    return (caption ? `**${caption}**\n\n` : '') + lines.join('\n');
  };

  const asCsv = (): string => {
    const data = extract();
    if (!data) return '';
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    return [data.head, ...data.rows].map((row) => row.map(cell).join(',')).join('\n');
  };

  const run = (kind: 'md' | 'csv') => {
    const text = kind === 'md' ? asMarkdown() : asCsv();
    if (!text) {
      flash('failed');
      return;
    }
    void copyText(text).then((ok) => flash(ok ? kind : 'failed'));
  };

  return (
    <span className="copy-table">
      <button onClick={() => run('md')} title="Copy this table as a Markdown table">
        {state === 'md' ? 'copied' : 'copy as markdown'}
      </button>
      <button onClick={() => run('csv')} title="Copy this table as CSV">
        {state === 'csv' ? 'copied' : 'csv'}
      </button>
      {state === 'failed' && <span className="warn">copy blocked</span>}
    </span>
  );
}
