import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api.js';

export interface PaletteAction {
  kind: 'view' | 'package' | 'repo' | 'compromised';
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K command palette.
 *
 * A tool with seven views and twelve thousand packages needs a way to get
 * anywhere without hunting. Package search hits the real `STARTS WITH` prefix
 * query on the server — it is not a filter over a preloaded list.
 */
export function CommandPalette({
  open,
  onClose,
  staticActions,
  onPickVersion,
  versionCount,
}: {
  open: boolean;
  onClose: () => void;
  staticActions: PaletteAction[];
  onPickVersion: (versionKey: string) => void;
  /** Live count from /api/stats — the prompt text should not quote a number the graph no longer holds. */
  versionCount?: number;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<PaletteAction[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setRemote([]);
      setActive(0);
      // Focus synchronously: effects run after the DOM is committed, so the
      // input already exists here. This used to be scheduled in a
      // requestAnimationFrame callback, which never runs while the page is
      // hidden or throttled — the palette then opened with focus still on the
      // body and the first thing typed went nowhere. A zero-delay timer repeats
      // it on the next macrotask so a browser that defers focus during a
      // transition still lands it, without depending on a frame being painted.
      inputRef.current?.focus();
      const retry = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(retry);
    }
  }, [open]);

  // Live package search against the graph.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      api
        .search(query.trim())
        .then(async (packages) => {
          if (cancelled) return;
          const actions: PaletteAction[] = [];
          for (const pkg of packages.slice(0, 6)) {
            actions.push({
              kind: 'package',
              label: pkg.key,
              hint: `${pkg.dependent_count} dependents`,
              run: () => {
                // Jump to the package's newest version — a package alone is not
                // addressable by the views, which all key on a version.
                void api.versions(pkg.key).then((result) => {
                  const newest = result.versions[0];
                  if (newest) onPickVersion(newest.key);
                });
              },
            });
          }
          setRemote(actions);
        })
        .catch(() => setRemote([]));
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open, onPickVersion]);

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const statics = needle
      ? staticActions.filter(
          (a) => a.label.toLowerCase().includes(needle) || a.hint?.toLowerCase().includes(needle),
        )
      : staticActions;
    return [...statics, ...remote];
  }, [query, staticActions, remote]);

  useEffect(() => {
    if (active >= items.length) setActive(0);
  }, [items.length, active]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % Math.max(1, items.length));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + items.length) % Math.max(1, items.length));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[active];
        if (item) {
          item.run();
          onClose();
        }
      }
    },
    [items, active, onClose],
  );

  if (!open) return null;

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={
            versionCount
              ? `Jump to a view, or search ${versionCount.toLocaleString()} package versions…`
              : 'Jump to a view, or search the graph…'
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="palette-list">
          {items.length === 0 && (
            <div className="palette-item">
              <span className="kind">no match</span>
              <span className="muted">Nothing matches “{query}”.</span>
            </div>
          )}
          {items.map((item, index) => (
            <div
              key={`${item.kind}-${item.label}`}
              className={`palette-item${index === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={() => {
                item.run();
                onClose();
              }}
            >
              <span className="kind">{item.kind}</span>
              <span className="mono">{item.label}</span>
              {item.hint && (
                <span className="muted" style={{ marginLeft: 'auto' }}>
                  {item.hint}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="palette-hint">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
