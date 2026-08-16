import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type StatsResponse } from './lib/api.js';
import { AttackClockView } from './views/AttackClockView.js';
import { BlastRadiusView } from './views/BlastRadiusView.js';
import { MaintainerView } from './views/MaintainerView.js';
import { CommandPalette, type PaletteAction } from './components/CommandPalette.js';
import { ConsoleView } from './views/ConsoleView.js';
import { RemediationView } from './views/RemediationView.js';
import { TimeMachineView } from './views/TimeMachineView.js';
import { TyposquatView } from './views/TyposquatView.js';

type Tab = 'blast' | 'time' | 'remediate' | 'maintainers' | 'typosquats' | 'clock' | 'console';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'blast', label: 'Blast radius' },
  { id: 'time', label: 'Time machine' },
  { id: 'remediate', label: 'Remediation' },
  { id: 'maintainers', label: 'Maintainer web' },
  { id: 'typosquats', label: 'Typosquats' },
  { id: 'clock', label: 'Attack clock' },
  { id: 'console', label: 'Cypher console' },
];

const VALID_TABS = new Set<Tab>(TABS.map((t) => t.id));

/** The URL is the source of truth for what is on screen, so any view can be
 *  linked to directly — useful in a demo and unremarkable to a user. */
function readUrl(): { tab: Tab | null; version: string | null } {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab') as Tab | null;
  return {
    tab: tab && VALID_TABS.has(tab) ? tab : null,
    version: params.get('v'),
  };
}

export function App(): JSX.Element {
  const initial = readUrl();
  const [tab, setTab] = useState<Tab>(initial.tab ?? 'blast');
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [versionKey, setVersionKey] = useState(initial.version ?? '');
  const [input, setInput] = useState(initial.version ?? '');
  const [error, setError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Set when a panel asks to show its query; the console opens pre-filled. */
  const [consoleQuery, setConsoleQuery] = useState<string | undefined>(undefined);
  /** Live counts on the sheet index, so the tab bar reads as a status board. */
  const [counts, setCounts] = useState<{ exposed: number; suspicious: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    api
      .stats()
      .then((result) => {
        setStats(result);
        // A version named in the URL wins; otherwise prefer the recorded
        // incident. A simulation leaves dozens of propagated versions marked,
        // most of which no lockfile pins — landing on one of those would show
        // empty views on every tab.
        if (readUrl().version) return;
        const incidentKey = result.incident?.version_key;
        const chosen =
          (incidentKey && result.compromised.find((v) => v.key === incidentKey)) ??
          result.compromised[0];
        if (chosen) {
          setVersionKey(chosen.key);
          setInput(chosen.key);
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Keep the URL in step with the view, without adding history entries for
  // every click — the back button should leave the app, not walk tabs.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', tab);
    if (versionKey) params.set('v', versionKey);
    window.history.replaceState(null, '', `?${params.toString()}`);
  }, [tab, versionKey]);

  // The tab bar carries the two counts a responder actually scans for, so the
  // headline numbers are visible before anything is clicked.
  useEffect(() => {
    if (!versionKey) return;
    let cancelled = false;
    Promise.all([api.exposure(versionKey, {}), api.typosquats()])
      .then(([exposure, typo]) => {
        if (cancelled) return;
        setCounts({
          exposed: exposure.exposedRepos.length,
          suspicious: typo.findings.filter((f) => f.verdict === 'SUSPICIOUS').length,
        });
      })
      .catch(() => {
        if (!cancelled) setCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [versionKey]);

  // ⌘K / Ctrl+K anywhere, number keys for direct tab access, ? for the list.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Bare keys only outside a field, or typing "1" into the version box would
      // navigate away mid-edit.
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }
      if (event.key === 'Escape') {
        setShortcutsOpen(false);
        return;
      }
      const index = Number(event.key);
      if (Number.isInteger(index) && index >= 1 && index <= TABS.length) {
        event.preventDefault();
        setTab(TABS[index - 1]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openInConsole = useCallback((cypher: string) => {
    setConsoleQuery(cypher);
    setTab('console');
  }, []);

  const selectVersion = useCallback((key: string) => {
    setVersionKey(key);
    setInput(key);
  }, []);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = TABS.map((entry) => ({
      kind: 'view' as const,
      label: entry.label,
      hint: 'view',
      run: () => setTab(entry.id),
    }));
    for (const version of stats?.compromised.slice(0, 8) ?? []) {
      actions.push({
        kind: 'compromised',
        label: version.key,
        hint: 'marked compromised',
        run: () => selectVersion(version.key),
      });
    }
    for (const repo of stats?.repos ?? []) {
      actions.push({
        kind: 'repo',
        label: repo.name,
        hint: repo.lockfileSource,
        run: () => setTab('blast'),
      });
    }
    return actions;
  }, [stats, selectVersion]);

  const packageKey = versionKey.includes('@')
    ? versionKey.slice(0, versionKey.lastIndexOf('@'))
    : versionKey;

  return (
    <div className="app">
      {/* The title block: who drew the sheet, what it covers, and how to index
          it. The sheet index sits on its own rule beneath, the way a chart set
          lists its sheets rather than crowding them into the title. */}
      <header className="top">
        <div className="title-block">
          <h1>
            BLAST <span>RADIUS</span>
          </h1>
          <div className="imprint">
            <span>supply-chain attack graph</span>
            <span className="sep" aria-hidden="true" />
            <span>HydraDB</span>
          </div>
          {/* The extent is a count over every edge type, which is a full scan and
              can take seconds on a cold cache. The block keeps its shape and
              labels while that resolves, so the title block does not reflow
              under the reader once the numbers land. */}
          <dl className="survey-extent">
            {([
              ['packages', stats?.stats.packages],
              ['versions', stats?.stats.versions],
              ['edges', stats?.stats.resolvedToEdges],
              ['repos', stats?.stats.repos],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value === undefined ? <span className="pending">measuring</span> : value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          <button className="action" onClick={() => setPaletteOpen(true)} title="Command palette">
            search <kbd>⌘K</kbd>
          </button>
        </div>
        <nav className="tabs" aria-label="Sheets">
          {TABS.map((entry, index) => {
            // Only two sheets carry a count, and both are counts a responder is
            // already looking for. A badge on every tab would be noise.
            const badge =
              entry.id === 'blast' ? counts?.exposed : entry.id === 'typosquats' ? counts?.suspicious : undefined;
            return (
              <button
                key={entry.id}
                className={tab === entry.id ? 'active' : ''}
                aria-current={tab === entry.id ? 'page' : undefined}
                onClick={() => setTab(entry.id)}
                title={`${entry.label}  (press ${index + 1})`}
              >
                {entry.label}
                {badge !== undefined && badge > 0 && (
                  <span className={`tab-badge${entry.id === 'blast' ? ' danger' : ' warn'}`}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {shortcutsOpen && (
        <div className="palette-backdrop" onMouseDown={() => setShortcutsOpen(false)}>
          <div className="shortcuts" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Keyboard</h2>
            <dl>
              {TABS.map((entry, index) => (
                <div key={entry.id}>
                  <dt>
                    <kbd>{index + 1}</kbd>
                  </dt>
                  <dd>{entry.label}</dd>
                </div>
              ))}
              <div>
                <dt>
                  <kbd>⌘K</kbd>
                </dt>
                <dd>search packages, repos and views</dd>
              </div>
              <div>
                <dt>
                  <kbd>⌘↵</kbd>
                </dt>
                <dd>run the query, in the console</dd>
              </div>
              <div>
                <dt>
                  <kbd>?</kbd>
                </dt>
                <dd>this list</dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        staticActions={paletteActions}
        onPickVersion={selectVersion}
        versionCount={stats?.stats.versions}
      />

      <main>
        {error && <div className="error">{error}</div>}

        {tab !== 'typosquats' && tab !== 'clock' && tab !== 'console' && (
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="row">
              <span className="muted">compromised version</span>
              <input
                type="text"
                value={input}
                spellCheck={false}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setVersionKey(input.trim());
                }}
                placeholder="npm:debug@4.4.3"
                className="version-input"
              />
              <button className="action" onClick={() => setVersionKey(input.trim())}>
                query
              </button>
              {stats && stats.compromised.length > 0 && (
                /* A wrapping flex row, not inline-with-margins. Inline pills
                   plus a trailing "+N more" overlapped once the list wrapped at
                   narrow widths, painting the count under the last pill. */
                <div className="marked-row">
                  <span className="muted">marked compromised:</span>
                  {stats.compromised.slice(0, 6).map((version) => (
                    <button
                      key={version.key}
                      className="pill danger"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setVersionKey(version.key);
                        setInput(version.key);
                      }}
                    >
                      {version.key}
                    </button>
                  ))}
                  {stats.compromised.length > 6 && (
                    <span className="muted">+{stats.compromised.length - 6} more</span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {!versionKey && tab !== 'typosquats' && tab !== 'clock' && tab !== 'console' && (
          <div className="empty">
            Nothing is marked compromised yet. Run <span className="mono">make demo</span>, or{' '}
            <span className="mono">blastradius mark-compromised &lt;version&gt; --from … --to …</span>
            .
          </div>
        )}

        {tab === 'blast' && versionKey && (
          <BlastRadiusView
            versionKey={versionKey}
            repos={stats?.repos ?? []}
            onShowQuery={openInConsole}
            onPickSuggestion={selectVersion}
          />
        )}
        {tab === 'time' && versionKey && (
          <TimeMachineView versionKey={versionKey} onShowQuery={openInConsole} />
        )}
        {tab === 'remediate' && versionKey && (
          <RemediationView versionKey={versionKey} onShowQuery={openInConsole} />
        )}
        {tab === 'maintainers' && versionKey && <MaintainerView packageKey={packageKey} />}
        {tab === 'typosquats' && <TyposquatView />}
        {tab === 'console' && (
          <ConsoleView seedVersionKey={versionKey} initialQuery={consoleQuery} />
        )}
        {tab === 'clock' && (
          <AttackClockView
            onSeedChange={(key) => {
              setVersionKey(key);
              setInput(key);
            }}
          />
        )}
      </main>
    </div>
  );
}
