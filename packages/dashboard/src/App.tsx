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

  // ⌘K / Ctrl+K anywhere, and ? for the shortcut list.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
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
      <header className="top">
        <h1>
          BLAST <span>RADIUS</span>
        </h1>
        <span className="muted" style={{ fontSize: 12.5 }}>
          supply-chain attack graph · HydraDB
        </span>
        {stats && (
          <span className="muted mono" style={{ fontSize: 12 }}>
            {stats.stats.packages?.toLocaleString()} packages ·{' '}
            {stats.stats.versions?.toLocaleString()} versions ·{' '}
            {stats.stats.resolvedToEdges?.toLocaleString()} resolved edges · {stats.stats.repos} repos
          </span>
        )}
        <button
          className="action"
          style={{ background: 'var(--panel-2)', color: 'var(--muted)', fontSize: 12 }}
          onClick={() => setPaletteOpen(true)}
          title="Command palette"
        >
          search <kbd>⌘K</kbd>
        </button>
        <nav className="tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={tab === entry.id ? 'active' : ''}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        staticActions={paletteActions}
        onPickVersion={selectVersion}
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
                style={{ minWidth: 340 }}
              />
              <button className="action" onClick={() => setVersionKey(input.trim())}>
                query
              </button>
              {stats && stats.compromised.length > 0 && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  marked compromised:{' '}
                  {stats.compromised.slice(0, 6).map((version) => (
                    <button
                      key={version.key}
                      className="pill danger"
                      style={{ cursor: 'pointer', marginRight: 6 }}
                      onClick={() => {
                        setVersionKey(version.key);
                        setInput(version.key);
                      }}
                    >
                      {version.key}
                    </button>
                  ))}
                  {stats.compromised.length > 6 && (
                    <span className="muted"> +{stats.compromised.length - 6} more</span>
                  )}
                </span>
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
          <BlastRadiusView versionKey={versionKey} repos={stats?.repos ?? []} onShowQuery={openInConsole} />
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
