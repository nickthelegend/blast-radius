/**
 * The Lockfile Time Machine.
 *
 * "Which of our repositories resolved the compromised version *while it was
 * live*?" — a different question from "which are exposed now", and the one a
 * flat scanner structurally cannot answer, because it only ever sees the
 * current state of a lockfile.
 *
 * The query is a point-in-time filter over `LockfileSnapshot.captured_at`
 * against the compromise window carried on the `Version` itself. Because
 * HydraDB has no temporal type, timestamps are epoch-millisecond integers, so
 * the window test is a plain inclusive integer range — `>=` and `<=` — that the
 * property index can serve directly.
 *
 * Every query in HydraDB runs against one pinned snapshot of the graph. Under
 * `strong` consistency the reader is refreshed from object storage before the
 * snapshot is pinned, which is what the dashboard's "verified" toggle turns on:
 * the answer is guaranteed to include every write committed before the query
 * began, rather than whatever the node had already caught up to.
 */
import type { HydraClient, QueryOptions } from '../hydra/client.js';
import type { LockfileSource } from '../model/types.js';
import type { VersionRef } from './lookup.js';

export interface SnapshotExposure {
  snapshotKey: string;
  repoKey: string;
  repoName: string;
  capturedAt: number;
  /** 0 when this lockfile is still the current one. */
  supersededAt: number;
  isCurrent: boolean;
  source: LockfileSource;
  commitSha: string;
  direct: boolean;
}

export interface TimeMachineReport {
  version: VersionRef;
  windowFrom: number;
  windowTo: number;
  /** Lockfiles captured inside [from, to] that pinned the bad version. */
  duringWindow: SnapshotExposure[];
  /** Of those, the ones since replaced — no longer live-exposed, but they WERE
   *  exposed during the incident and still warrant a security review. */
  supersededSinceWindow: SnapshotExposure[];
  /** Of those, the ones still current — exposed during the window AND now. */
  stillCurrent: SnapshotExposure[];
  /** Pinned the bad version, but outside the window. Useful context: these
   *  repos touched the package, just not while it was malicious. */
  outsideWindow: SnapshotExposure[];
  elapsedMs: number;
  consistency: string;
  verified: boolean;
  readEpoch: number | null;
  cypher: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

const SNAPSHOT_PROJECTION =
  'RETURN s.key AS key, s.repo_key AS repo_key, s.repo_name AS repo_name, ' +
  's.captured_at AS captured_at, s.superseded_at AS superseded_at, s.is_current AS is_current, ' +
  's.source AS source, s.commit_sha AS commit_sha, r.direct AS direct ' +
  'ORDER BY captured_at';

function toExposure(record: Record<string, unknown>): SnapshotExposure {
  return {
    snapshotKey: str(record.key),
    repoKey: str(record.repo_key),
    repoName: str(record.repo_name),
    capturedAt: numberOf(record.captured_at),
    supersededAt: numberOf(record.superseded_at),
    isCurrent: record.is_current === true,
    source: str(record.source) as LockfileSource,
    commitSha: str(record.commit_sha),
    direct: record.direct === true,
  };
}

export interface TimeMachineOptions {
  /** Overrides the window carried on the Version node. */
  from?: number;
  to?: number;
  /** When true, reads with `strong` consistency (the "verified" toggle). */
  verified?: boolean;
  consistency?: QueryOptions['consistency'];
}

export async function timeMachine(
  client: HydraClient,
  version: VersionRef,
  options: TimeMachineOptions = {},
): Promise<TimeMachineReport> {
  const from = options.from ?? version.compromisedFrom;
  const to = options.to ?? version.compromisedTo;

  if (!from || !to) {
    throw new Error(
      `${version.key} has no compromise window. Set one first:\n` +
        `  blastradius mark-compromised ${version.key} --from <ISO> --to <ISO>`,
    );
  }
  if (to < from) {
    throw new Error(`compromise window ends before it starts: ${from} > ${to}`);
  }

  const verified = options.verified ?? false;
  const consistency = options.consistency ?? (verified ? 'strong' : 'causal');

  // Inclusive on both ends: a lockfile captured at the exact instant the
  // malicious version went live resolved to it, and so did one captured at the
  // instant it was pulled. `tests/integration/time-machine-boundary.test.ts` pins all four
  // boundary cases (at-start, at-end, just-before, just-after).
  const windowCypher =
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $version_id}) ' +
    'WHERE s.captured_at >= $from AND s.captured_at <= $to ' +
    SNAPSHOT_PROJECTION;

  const insideResult = await client.query(windowCypher, {
    consistency,
    parameters: { version_id: version.id, from, to },
  });

  // HydraDB's WHERE has no OR-of-ranges shortcut worth the complexity here, and
  // no `IN`; two cheap directional queries are clearer than one clever one.
  const beforeResult = await client.query(
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $version_id}) ' +
      'WHERE s.captured_at < $from ' +
      SNAPSHOT_PROJECTION,
    { consistency, parameters: { version_id: version.id, from } },
  );
  const afterResult = await client.query(
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $version_id}) ' +
      'WHERE s.captured_at > $to ' +
      SNAPSHOT_PROJECTION,
    { consistency, parameters: { version_id: version.id, to } },
  );

  const duringWindow = insideResult.records.map(toExposure);
  const outsideWindow = [...beforeResult.records, ...afterResult.records]
    .map(toExposure)
    .sort((a, b) => a.capturedAt - b.capturedAt);

  return {
    version,
    windowFrom: from,
    windowTo: to,
    duringWindow,
    supersededSinceWindow: duringWindow.filter((exposure) => !exposure.isCurrent),
    stillCurrent: duringWindow.filter((exposure) => exposure.isCurrent),
    outsideWindow,
    elapsedMs: insideResult.elapsedMs + beforeResult.elapsedMs + afterResult.elapsedMs,
    consistency,
    verified,
    readEpoch: insideResult.readEpoch,
    cypher: windowCypher,
  };
}

/**
 * Point-in-time query: which lockfiles resolved this version *as of* an
 * arbitrary instant? Powers the dashboard's timeline scrubber, which is the
 * Time Machine generalised beyond a single incident window.
 *
 * "As of T" means the snapshot was captured at or before T and had not yet been
 * superseded — a snapshot with `superseded_at = 0` is still current, so it
 * counts for every T after its capture.
 */
export async function exposureAsOf(
  client: HydraClient,
  version: VersionRef,
  instant: number,
  options: { consistency?: QueryOptions['consistency'] } = {},
): Promise<SnapshotExposure[]> {
  const result = await client.query(
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $version_id}) ' +
      'WHERE s.captured_at <= $instant ' +
      SNAPSHOT_PROJECTION,
    { consistency: options.consistency, parameters: { version_id: version.id, instant } },
  );
  return result.records
    .map(toExposure)
    .filter((exposure) => exposure.supersededAt === 0 || exposure.supersededAt > instant);
}

/** Every lockfile that ever pinned this version, for the timeline view. */
export async function allExposures(
  client: HydraClient,
  version: VersionRef,
  options: { consistency?: QueryOptions['consistency'] } = {},
): Promise<SnapshotExposure[]> {
  const result = await client.query(
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $version_id}) ' + SNAPSHOT_PROJECTION,
    { consistency: options.consistency, parameters: { version_id: version.id } },
  );
  return result.records.map(toExposure);
}

/* -------------------------------------------------------------------------- */
/* Exposure diff                                                              */
/* -------------------------------------------------------------------------- */

export interface ExposureDiff {
  version: VersionRef;
  from: number;
  to: number;
  /** Not exposed at `from`, exposed at `to`. */
  entered: SnapshotExposure[];
  /** Exposed at `from`, not exposed at `to`. */
  cleared: SnapshotExposure[];
  /** Exposed at both instants — still outstanding. */
  unchanged: SnapshotExposure[];
  /** Pinned this version at some point, but at neither instant. */
  untouched: string[];
  readEpoch: number | null;
  elapsedMs: number;
  cypher: string;
}

/** Which snapshots were live at an instant, out of an already-fetched set. */
function liveAt(exposures: SnapshotExposure[], instant: number): SnapshotExposure[] {
  return exposures.filter(
    (exposure) =>
      exposure.capturedAt <= instant &&
      (exposure.supersededAt === 0 || exposure.supersededAt > instant),
  );
}

/**
 * What changed between two instants.
 *
 * The Time Machine answers "who was exposed at 09:03". The next question an
 * incident commander asks is "what has changed since I last looked", which is a
 * different query.
 *
 * It is deliberately **one** read, not two. Every lockfile that ever pinned this
 * version comes back once, and both instants are then evaluated over that single
 * result — so the two sides of the diff are guaranteed to come from the same
 * read epoch. Issuing two point-in-time queries would let a write land between
 * them, and the diff would report a change that was true at neither instant:
 * the one failure mode that would make this worse than not having it.
 */
export async function exposureDiff(
  client: HydraClient,
  version: VersionRef,
  from: number,
  to: number,
  options: { consistency?: QueryOptions['consistency'] } = {},
): Promise<ExposureDiff> {
  if (to < from) {
    throw new Error(
      `diff window ends before it starts: ${new Date(from).toISOString()} > ${new Date(to).toISOString()}`,
    );
  }

  const started = Date.now();
  const cypher =
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $version_id}) ' + SNAPSHOT_PROJECTION;

  const result = await client.query(cypher, {
    consistency: options.consistency,
    parameters: { version_id: version.id },
  });
  const ever = result.records.map(toExposure);

  const beforeByRepo = new Map(liveAt(ever, from).map((e) => [e.repoName, e]));
  const afterByRepo = new Map(liveAt(ever, to).map((e) => [e.repoName, e]));

  const entered = [...afterByRepo].filter(([name]) => !beforeByRepo.has(name)).map(([, e]) => e);
  const cleared = [...beforeByRepo].filter(([name]) => !afterByRepo.has(name)).map(([, e]) => e);
  const unchanged = [...afterByRepo].filter(([name]) => beforeByRepo.has(name)).map(([, e]) => e);

  // "Not in the diff" and "never affected" are different answers, and conflating
  // them is how a repository gets missed.
  const touched = new Set([...beforeByRepo.keys(), ...afterByRepo.keys()]);
  const untouched = [
    ...new Set(ever.map((e) => e.repoName).filter((name) => !touched.has(name))),
  ].sort();

  const byName = (a: SnapshotExposure, b: SnapshotExposure) => a.repoName.localeCompare(b.repoName);

  return {
    version,
    from,
    to,
    entered: entered.sort(byName),
    cleared: cleared.sort(byName),
    unchanged: unchanged.sort(byName),
    untouched,
    readEpoch: result.readEpoch ?? null,
    elapsedMs: Date.now() - started,
    cypher,
  };
}
