import { useCallback, useEffect, useRef, useState } from 'react';

import { ForceGraph } from '../components/ForceGraph.js';
import { api, fmtMs, type GraphResponse, type ScenarioSummary } from '../lib/api.js';

interface SimEvent {
  type: 'preparing' | 'start' | 'publish' | 'measure' | 'done' | 'error';
  [key: string]: unknown;
}

/**
 * The attack clock.
 *
 * Streams the simulation over SSE and re-renders exposure as it spreads. The
 * counts are not animated from a script: each `measure` event is the result of
 * a real `algo.SSpaths` traversal that just ran against HydraDB, and the query
 * time shown beside it is that call's latency.
 */
export function AttackClockView({
  onSeedChange,
}: {
  onSeedChange?: (versionKey: string) => void;
}): JSX.Element {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [scenario, setScenario] = useState('tanstack-worm-2026');
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [clock, setClock] = useState('00:00');
  const [exposed, setExposed] = useState(0);
  const [packages, setPackages] = useState(0);
  const [artifacts, setArtifacts] = useState(0);
  const [queryMs, setQueryMs] = useState(0);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [seedKey, setSeedKey] = useState('');
  const sourceRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  // Only the `start` event carries the window bounds; later events are relative
  // to it, so it is held here rather than re-read off each message.
  const windowFromRef = useRef(0);

  useEffect(() => {
    api.scenarios().then(setScenarios).catch(() => undefined);
    return () => sourceRef.current?.close();
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const append = useCallback((line: string) => {
    setLines((previous) => [...previous.slice(-400), line]);
  }, []);

  const start = useCallback(() => {
    sourceRef.current?.close();
    setLines([]);
    setExposed(0);
    setPackages(0);
    setArtifacts(0);
    setClock('00:00');
    setRunning(true);

    const source = new EventSource(`/api/simulate?scenario=${encodeURIComponent(scenario)}`);
    sourceRef.current = source;

    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as SimEvent;

      if (event.type === 'preparing') {
        append(`PREPARING  resolving the seed and propagation surface…`);
      }

      if (event.type === 'start') {
        const seed = (event.seed as { key: string }).key;
        setSeedKey(seed);
        onSeedChange?.(seed);
        windowFromRef.current = event.windowFrom as number;
        const info = event.scenario as ScenarioSummary;
        append(`SCENARIO  ${info.title}`);
        append(`SEED      ${seed}`);
        append(`WINDOW    ${info.windowMinutes} minutes`);
        append('─'.repeat(64));
        api.graph(seed).then(setGraph).catch(() => undefined);
      }

      if (event.type === 'publish') {
        const offset = clockOf(event.simulatedAt as number, windowFromRef.current);
        setArtifacts(event.artifactIndex as number);
        append(
          `T+${offset}  PUBLISH  ${String(event.versionKey).padEnd(38)} via ${String(event.viaMaintainer)}`,
        );
      }

      if (event.type === 'measure') {
        setExposed(event.exposedRepoCount as number);
        setPackages(event.exposedPackageCount as number);
        setQueryMs(event.queryMs as number);
        const stamp = clockOf(event.simulatedAt as number, windowFromRef.current);
        setClock(stamp);
        append(
          `T+${stamp}  EXPOSED  ` +
            `${String(event.exposedRepoCount).padStart(3)} repos   ` +
            `${String(event.exposedPackageCount).padStart(4)} packages   ` +
            `${fmtMs(event.queryMs as number)} (algo.SSpaths)`,
        );
      }

      if (event.type === 'done') {
        append('─'.repeat(64));
        append(`COMPLETE  ${(event.compromisedVersionKeys as string[]).length} versions compromised`);
        setRunning(false);
        source.close();
        if (seedKey) api.graph(seedKey).then(setGraph).catch(() => undefined);
      }

      if (event.type === 'error') {
        append(`ERROR     ${String(event.message)}`);
        setRunning(false);
        source.close();
      }
    };

    source.onerror = () => {
      setRunning(false);
      source.close();
    };
  }, [scenario, append, onSeedChange, seedKey]);

  const stop = useCallback(() => {
    sourceRef.current?.close();
    setRunning(false);
  }, []);

  const active = scenarios.find((entry) => entry.name === scenario);

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row">
          <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
            {scenarios.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.title}
              </option>
            ))}
          </select>
          <button className="action danger" onClick={running ? stop : start}>
            {running ? 'stop' : 'run incident'}
          </button>
          {active && (
            <span className="muted scenario-note">
              {active.reference}
            </span>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Attack clock</h2>
          <p className="sub">
            Elapsed time inside the compromise window. Every exposure count is a live traversal.
          </p>
          <div className="clock danger">T+{clock}</div>
          <div className="stat-row" style={{ marginTop: 14 }}>
            <div className="stat">
              <span className="value danger">{exposed}</span>
              <span className="label">repos exposed</span>
            </div>
            <div className="stat">
              <span className="value">{packages}</span>
              <span className="label">packages reached</span>
            </div>
            <div className="stat">
              <span className="value warn">{artifacts}</span>
              <span className="label">malicious artifacts</span>
            </div>
            <div className="stat">
              <span className="value" style={{ color: 'var(--survey)' }}>
                {queryMs ? fmtMs(queryMs) : '—'}
              </span>
              <span className="label">last traversal</span>
            </div>
          </div>
          <div className="log" ref={logRef} style={{ marginTop: 14 }}>
            {lines.map((line, index) => (
              <div
                key={index}
                className={
                  line.includes('PUBLISH') ? 'danger' : line.includes('EXPOSED') ? '' : 'muted'
                }
              >
                {line}
              </div>
            ))}
            {lines.length === 0 && (
              <div className="muted">
                {running ? 'connecting…' : 'press “run incident” to begin'}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <h2>Spread</h2>
          <p className="sub">Exposure radiating out from the compromised version.</p>
          {graph && graph.nodes.length > 0 ? (
            <ForceGraph nodes={graph.nodes} links={graph.links} sourceId={graph.source.id} />
          ) : (
            <div className="empty">run the scenario to populate the graph</div>
          )}
        </div>
      </div>
    </div>
  );
}

function clockOf(simulatedAt: number, windowFrom: number): string {
  if (!windowFrom) return '00:00';
  const seconds = Math.max(0, Math.round((simulatedAt - windowFrom) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
