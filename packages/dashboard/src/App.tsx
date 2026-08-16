import { useEffect, useState } from 'react';

import { api, type StatsResponse } from './lib/api.js';
import { AttackClockView } from './views/AttackClockView.js';
import { BlastRadiusView } from './views/BlastRadiusView.js';
import { MaintainerView } from './views/MaintainerView.js';
import { TimeMachineView } from './views/TimeMachineView.js';
import { TyposquatView } from './views/TyposquatView.js';

type Tab = 'blast' | 'time' | 'maintainers' | 'typosquats' | 'clock';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'blast', label: 'Blast radius' },
  { id: 'time', label: 'Time machine' },
  { id: 'maintainers', label: 'Maintainer web' },
  { id: 'typosquats', label: 'Typosquats' },
  { id: 'clock', label: 'Attack clock' },
];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('blast');
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [versionKey, setVersionKey] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .stats()
      .then((result) => {
        setStats(result);
        // Default to whatever is currently marked compromised — after
        // `make demo` that is the incident the whole dataset was built around.
        const first = result.compromised[0];
        if (first) {
          setVersionKey(first.key);
          setInput(first.key);
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

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

      <main>
        {error && <div className="error">{error}</div>}

        {tab !== 'typosquats' && tab !== 'clock' && (
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
                  {stats.compromised.map((version) => (
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
                </span>
              )}
            </div>
          </div>
        )}

        {!versionKey && tab !== 'typosquats' && tab !== 'clock' && (
          <div className="empty">
            Nothing is marked compromised yet. Run <span className="mono">make demo</span>, or{' '}
            <span className="mono">blastradius mark-compromised &lt;version&gt; --from … --to …</span>
            .
          </div>
        )}

        {tab === 'blast' && versionKey && (
          <BlastRadiusView versionKey={versionKey} repos={stats?.repos ?? []} />
        )}
        {tab === 'time' && versionKey && <TimeMachineView versionKey={versionKey} />}
        {tab === 'maintainers' && versionKey && <MaintainerView packageKey={packageKey} />}
        {tab === 'typosquats' && <TyposquatView />}
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
