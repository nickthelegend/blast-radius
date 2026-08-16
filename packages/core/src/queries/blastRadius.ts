/**
 * Blast radius — current exposure.
 *
 * The whole query is a single native traversal. Starting at the compromised
 * `Version` and walking edges *backwards* (`relDirection: 'incoming'`) over
 * three relationship types at once:
 *
 *     Version <-[:RESOLVED_TO]- Version        (a dependent package version)
 *             <-[:RESOLVED]-    LockfileSnapshot
 *             <-[:HAS_SNAPSHOT]- Repo
 *
 * one call returns, for every reachable node, the shortest chain from the
 * compromised version out to it. Paths that terminate at a `Repo` are the
 * answer to "which of my services are exposed"; the path itself is the
 * dependency chain the report prints, and no second query is needed to explain
 * a result.
 *
 * Two engine behaviours are load-bearing here:
 *   - `pathCount` is a TOTAL path budget that defaults to 1. It is always set
 *     explicitly; leaving it unset silently returns one path.
 *   - Returned path nodes carry their labels *and properties*, so exposure can
 *     be attributed and filtered (current vs superseded lockfile) without any
 *     follow-up round trip.
 */
import { HydraError, type GraphPath, type HydraClient, type QueryOptions } from '../hydra/client.js';
import type { VersionRef } from './lookup.js';

/**
 * `RESOLVED_DIRECT`, not `RESOLVED`: a lockfile pins its whole tree, so
 * traversing `RESOLVED` would take a one-hop shortcut to every transitive
 * package and report every exposure as depth 1. Entering through a direct
 * dependency and then walking `RESOLVED_TO` recovers the real chain.
 */
export const BLAST_REL_TYPES = ['RESOLVED_TO', 'RESOLVED_DIRECT', 'HAS_SNAPSHOT'] as const;

export interface ChainLink {
  kind: 'version' | 'snapshot' | 'repo';
  label: string;
  key: string;
}

export interface ExposedRepo {
  repoKey: string;
  repoName: string;
  /** Number of RESOLVED_TO hops — i.e. true dependency depth, excluding the
   *  RESOLVED and HAS_SNAPSHOT edges that carry the path out to the repo. */
  depth: number;
  /** Dependency chain, ordered repo -> ... -> compromised package. */
  chain: ChainLink[];
  chainText: string;
  snapshotKey: string;
  snapshotCapturedAt: number;
  /** False when the exposure runs through a lockfile that has been superseded. */
  viaCurrentLockfile: boolean;
  /** True when the compromised package is a direct dependency of the repo. */
  direct: boolean;
}

export interface ExposedPackage {
  versionKey: string;
  packageName: string;
  versionString: string;
  depth: number;
}

export interface BlastRadiusReport {
  source: VersionRef;
  exposedRepos: ExposedRepo[];
  /** Repos whose exposure only runs through a superseded lockfile. They are not
   *  live-exposed, but they were — the Time Machine explains when. */
  historicallyExposedRepos: ExposedRepo[];
  exposedPackages: ExposedPackage[];
  totalPaths: number;
  maxDepthUsed: number;
  pathCountUsed: number;
  truncated: boolean;
  elapsedMs: number;
  consistency: string;
  procedure: 'algo.SSpaths' | 'algo.MSpaths';
  cypher: string;
}

export interface BlastRadiusOptions {
  maxDepth: number;
  pathCount: number;
  resultLimit: number;
  consistency?: QueryOptions['consistency'];
  /** Called if the path budget had to be reduced to fit the server's cursor
   *  buffer — a reduced budget can under-report, so it is never silent. */
  onDegrade?: (pathCount: number, reason: string) => void;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

function labelOf(node: GraphPath['nodes'][number]): ChainLink['kind'] | null {
  if (node.labels.includes('Repo')) return 'repo';
  if (node.labels.includes('LockfileSnapshot')) return 'snapshot';
  if (node.labels.includes('Version')) return 'version';
  return null;
}

/**
 * Turn one returned path into an exposure record.
 *
 * The path arrives oriented from the compromised version outwards. It is
 * reversed for display, because a human reads exposure as
 * "payments-service -> stripe-utils -> left-pad", not the other way round.
 */
function toExposedRepo(path: GraphPath): ExposedRepo | null {
  const last = path.nodes[path.nodes.length - 1];
  if (!last || !last.labels.includes('Repo')) return null;

  const chain: ChainLink[] = [];
  let snapshotKey = '';
  let snapshotCapturedAt = 0;
  let viaCurrentLockfile = true;
  let depth = 0;

  for (const node of path.nodes) {
    const kind = labelOf(node);
    if (!kind) continue;
    if (kind === 'snapshot') {
      snapshotKey = str(node.properties.key);
      snapshotCapturedAt = numberOf(node.properties.captured_at);
      viaCurrentLockfile = node.properties.is_current === true;
      continue; // the lockfile is metadata about the edge, not a chain link
    }
    chain.push({
      kind,
      label:
        kind === 'version'
          ? `${str(node.properties.package_name)}@${str(node.properties.version_string)}`
          : str(node.properties.name),
      key: str(node.properties.key),
    });
  }

  for (const relationship of path.relationships) {
    if (relationship.type === 'RESOLVED_TO') depth += 1;
  }

  // A direct dependency means the repo's lockfile pinned the compromised
  // version itself: zero RESOLVED_TO hops between snapshot and version.
  const direct = depth === 0;

  const ordered = [...chain].reverse();
  return {
    repoKey: str(last.properties.key),
    repoName: str(last.properties.name),
    depth: depth + 1,
    chain: ordered,
    chainText: ordered.map((link) => link.label).join(' -> '),
    snapshotKey,
    snapshotCapturedAt,
    viaCurrentLockfile,
    direct,
  };
}

/**
 * Which lockfiles actually pin this exact version.
 *
 * This is the authoritative membership test, and it is deliberately separate
 * from the traversal. The traversal walks the *global* package resolution
 * graph, so it will happily reach a compromised version from any direct
 * dependency that resolves to it in general — including for a repo whose
 * lockfile has since dropped it. A lockfile is the record of what a repo
 * actually ships, so it decides exposure; the traversal only explains it.
 *
 * Without this intersection, a repo that upgraded away from the bad version
 * still reports as exposed, which would quietly destroy the "exposed now" vs
 * "exposed during the window" distinction the whole product rests on.
 */
async function pinnedBy(
  client: HydraClient,
  source: VersionRef,
  consistency: QueryOptions['consistency'],
): Promise<{ current: Map<string, PinInfo>; historical: Map<string, PinInfo> }> {
  const result = await client.query(
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version {id: $version_id}) ' +
      'RETURN s.key AS key, s.repo_key AS repo_key, s.repo_name AS repo_name, ' +
      's.captured_at AS captured_at, s.is_current AS is_current, r.direct AS direct ' +
      'ORDER BY captured_at DESC',
    { consistency, parameters: { version_id: source.id } },
  );

  const current = new Map<string, PinInfo>();
  const historical = new Map<string, PinInfo>();
  for (const record of result.records) {
    const info: PinInfo = {
      snapshotKey: str(record.key),
      repoKey: str(record.repo_key),
      repoName: str(record.repo_name),
      capturedAt: numberOf(record.captured_at),
      isCurrent: record.is_current === true,
      direct: record.direct === true,
    };
    const bucket = info.isCurrent ? current : historical;
    // Newest first, so the first entry per repo is the one that matters.
    if (!bucket.has(info.repoKey)) bucket.set(info.repoKey, info);
  }
  for (const repoKey of current.keys()) historical.delete(repoKey);
  return { current, historical };
}

interface PinInfo {
  snapshotKey: string;
  repoKey: string;
  repoName: string;
  capturedAt: number;
  isCurrent: boolean;
  direct: boolean;
}

function buildReport(
  source: VersionRef,
  paths: GraphPath[],
  pins: { current: Map<string, PinInfo>; historical: Map<string, PinInfo> },
  options: BlastRadiusOptions,
  meta: {
    elapsedMs: number;
    consistency: string;
    procedure: BlastRadiusReport['procedure'];
    cypher: string;
  },
): BlastRadiusReport {
  const packages = new Map<string, ExposedPackage>();
  // Chains keyed by the snapshot they arrive through, so each repo is explained
  // by its own lockfile rather than by whichever path happened to be shortest.
  const chainsBySnapshot = new Map<string, ExposedRepo>();

  for (const path of paths) {
    const last = path.nodes[path.nodes.length - 1];
    if (!last) continue;

    if (last.labels.includes('Version')) {
      const key = str(last.properties.key);
      const depth = path.relationships.filter((r) => r.type === 'RESOLVED_TO').length;
      const existing = packages.get(key);
      if (!existing || depth < existing.depth) {
        packages.set(key, {
          versionKey: key,
          packageName: str(last.properties.package_name),
          versionString: str(last.properties.version_string),
          depth,
        });
      }
      continue;
    }

    const exposure = toExposedRepo(path);
    if (!exposure || !exposure.snapshotKey) continue;
    const existing = chainsBySnapshot.get(exposure.snapshotKey);
    // Keep the shallowest chain per snapshot: the most actionable explanation.
    if (!existing || exposure.depth < existing.depth) {
      chainsBySnapshot.set(exposure.snapshotKey, exposure);
    }
  }

  /** Combine the authoritative pin with the traversal's explanation. */
  const materialise = (pin: PinInfo): ExposedRepo => {
    const chain = chainsBySnapshot.get(pin.snapshotKey);
    if (chain) return { ...chain, viaCurrentLockfile: pin.isCurrent };
    // The lockfile pins it, but no chain came back within the depth budget —
    // either it is a direct pin, or the chain is longer than maxDepth.
    return {
      repoKey: pin.repoKey,
      repoName: pin.repoName,
      depth: 1,
      chain: [
        { kind: 'repo', label: pin.repoName, key: pin.repoKey },
        {
          kind: 'version',
          label: `${source.packageName}@${source.versionString}`,
          key: source.key,
        },
      ],
      chainText: `${pin.repoName} -> ${source.packageName}@${source.versionString}`,
      snapshotKey: pin.snapshotKey,
      snapshotCapturedAt: pin.capturedAt,
      viaCurrentLockfile: pin.isCurrent,
      direct: pin.direct,
    };
  };

  const live = new Map<string, ExposedRepo>();
  for (const [repoKey, pin] of pins.current) live.set(repoKey, materialise(pin));
  const historical = new Map<string, ExposedRepo>();
  for (const [repoKey, pin] of pins.historical) historical.set(repoKey, materialise(pin));

  const byDepth = (a: ExposedRepo, b: ExposedRepo) =>
    a.depth - b.depth || a.repoName.localeCompare(b.repoName);

  return {
    source,
    exposedRepos: [...live.values()].sort(byDepth),
    historicallyExposedRepos: [...historical.values()].sort(byDepth),
    exposedPackages: [...packages.values()].sort(
      (a, b) => a.depth - b.depth || a.packageName.localeCompare(b.packageName),
    ),
    totalPaths: paths.length,
    maxDepthUsed: options.maxDepth,
    pathCountUsed: options.pathCount,
    // If the engine returned exactly the budget, the answer may be incomplete —
    // silently under-reporting a blast radius is the worst failure this tool has.
    truncated: paths.length >= Math.min(options.pathCount, options.resultLimit),
    elapsedMs: meta.elapsedMs,
    consistency: meta.consistency,
    procedure: meta.procedure,
    cypher: meta.cypher,
  };
}

/**
 * Run a path procedure, backing off if the response is too large for the
 * server's cursor buffer.
 *
 * Whole paths carry every node's full property map, so a wide radius can run to
 * tens of megabytes and trip admission control with
 * `client_cursor_buffer_bytes ... exceeds limit`. Rather than failing the
 * report outright, the budget is halved and retried — and the caller is told,
 * because a reduced budget is exactly the condition under which a blast radius
 * can silently under-report.
 */
async function runPathProcedure(
  client: HydraClient,
  build: (pathCount: number, resultLimit: number) => string,
  options: BlastRadiusOptions,
  onDegrade?: (pathCount: number, reason: string) => void,
): Promise<{ cypher: string; records: Array<Record<string, unknown>>; elapsedMs: number; pathCount: number }> {
  let pathCount = options.pathCount;
  let resultLimit = options.resultLimit;

  for (let attempt = 0; attempt < 4; attempt++) {
    const cypher = build(pathCount, resultLimit);
    try {
      const result = await client.query(cypher, { consistency: options.consistency, retries: 0 });
      return { cypher, records: result.records, elapsedMs: result.elapsedMs, pathCount };
    } catch (error) {
      const isBufferLimit =
        error instanceof HydraError &&
        (error.status === 429 || error.status === 507) &&
        /cursor_buffer|resource_exhausted/i.test(error.message);
      if (!isBufferLimit || attempt === 3) throw error;
      pathCount = Math.max(500, Math.floor(pathCount / 2));
      resultLimit = Math.max(500, Math.floor(resultLimit / 2));
      onDegrade?.(pathCount, error.message);
    }
  }
  throw new Error('unreachable');
}

function extractPaths(records: Array<Record<string, unknown>>): GraphPath[] {
  const paths: GraphPath[] = [];
  for (const record of records) {
    const value = record.path;
    if (value && typeof value === 'object' && 'nodes' in value) paths.push(value as GraphPath);
  }
  return paths;
}

/**
 * Full blast radius from one compromised version, via `algo.SSpaths`.
 * This is the "what is the complete blast radius" query.
 */
export async function blastRadius(
  client: HydraClient,
  source: VersionRef,
  options: BlastRadiusOptions,
): Promise<BlastRadiusReport> {
  const maxLen = options.maxDepth + 2; // + RESOLVED_DIRECT + HAS_SNAPSHOT
  const relTypes = BLAST_REL_TYPES.map((type) => `'${type}'`).join(', ');
  const build = (pathCount: number, resultLimit: number) =>
    `CALL algo.SSpaths({sourceNode: ${source.id}, relTypes: [${relTypes}], ` +
    `relDirection: 'incoming', maxLen: ${maxLen}, pathCount: ${pathCount}, ` +
    `resultLimit: ${resultLimit}}) YIELD path RETURN path`;

  const [result, pins] = await Promise.all([
    runPathProcedure(client, build, options, options.onDegrade),
    pinnedBy(client, source, options.consistency),
  ]);
  return buildReport(source, extractPaths(result.records), pins, { ...options, pathCount: result.pathCount }, {
    elapsedMs: result.elapsedMs,
    consistency: options.consistency ?? 'causal',
    procedure: 'algo.SSpaths',
    cypher: result.cypher,
  });
}

/**
 * Targeted multi-repo check via `algo.MSpaths` — one round trip that resolves
 * many indexed source/target pairs inside the engine instead of fanning out N
 * queries from the client.
 *
 * `pairwise` defaults to false, and that is deliberate. In `pairwise: true`
 * mode this build of HydraDB silently drops every pair whose source vertex id
 * is greater than its target's: the identical pair returns its path in
 * non-pairwise mode and nothing in pairwise mode. Since node ids are an
 * allocation detail, pairwise would drop roughly half of all exposures at
 * random. Non-pairwise (1 source x N targets) is exactly the shape this check
 * needs anyway, and it is correct in every direction.
 * `tests/integration/mspaths-pairwise.test.ts` pins the discrepancy down.
 */
export async function blastRadiusForRepos(
  client: HydraClient,
  source: VersionRef,
  repoKeys: string[],
  options: BlastRadiusOptions & { pairwise?: boolean },
): Promise<BlastRadiusReport> {
  const maxLen = options.maxDepth + 2;
  const relTypes = BLAST_REL_TYPES.map((type) => `'${type}'`).join(', ');
  const pairwise = options.pairwise ?? false;
  const escape = (value: string) => value.replace(/'/g, "\\'");
  const sourceValues = pairwise
    ? repoKeys.map(() => `'${escape(source.key)}'`).join(', ')
    : `'${escape(source.key)}'`;
  const targetValues = repoKeys.map((key) => `'${escape(key)}'`).join(', ');

  const build = (pathCount: number, resultLimit: number) =>
    `CALL algo.MSpaths({sourceLabel: 'Version', sourceProperty: 'key', ` +
    `sourceValues: [${sourceValues}], ` +
    `targetLabel: 'Repo', targetProperty: 'key', targetValues: [${targetValues}], ` +
    `pairwise: ${pairwise}, relTypes: [${relTypes}], relDirection: 'incoming', ` +
    `maxLen: ${maxLen}, pathCount: ${pathCount}, resultLimit: ${resultLimit}}) ` +
    `YIELD path RETURN path`;

  const [result, allPins] = await Promise.all([
    runPathProcedure(client, build, options, options.onDegrade),
    pinnedBy(client, source, options.consistency),
  ]);

  // Restrict the authoritative pin set to the repos actually asked about.
  const wanted = new Set(repoKeys);
  const pins = {
    current: new Map([...allPins.current].filter(([repoKey]) => wanted.has(repoKey))),
    historical: new Map([...allPins.historical].filter(([repoKey]) => wanted.has(repoKey))),
  };

  return buildReport(source, extractPaths(result.records), pins, { ...options, pathCount: result.pathCount }, {
    elapsedMs: result.elapsedMs,
    consistency: options.consistency ?? 'causal',
    procedure: 'algo.MSpaths',
    cypher: result.cypher,
  });
}

/**
 * Combined exposure from *many* compromised versions at once.
 *
 * This is the query a spreading worm actually poses: not "who is exposed to
 * this one package" but "who is exposed to anything the attacker now controls".
 * `algo.MSpaths` answers it in a single round trip by taking every compromised
 * version as an indexed source and every repo as a target, instead of the
 * client issuing one traversal per compromised package and unioning the results
 * itself.
 *
 * Non-pairwise: the source and target sets are unrelated lists here, and
 * pairwise mode is both wrong for that shape and defective in this build (see
 * `blastRadiusForRepos`).
 */
export async function combinedExposure(
  client: HydraClient,
  compromisedVersionKeys: string[],
  repoKeys: string[],
  options: BlastRadiusOptions,
): Promise<{
  /** Repos whose *current* lockfile pins one of the compromised versions. */
  exposedRepos: Set<string>;
  /** Repos the traversal can reach at all, current lockfile or not. Always a
   *  superset of `exposedRepos`; the difference is repos that have upgraded. */
  reachableRepos: Set<string>;
  elapsedMs: number;
  cypher: string;
  totalPaths: number;
}> {
  if (compromisedVersionKeys.length === 0 || repoKeys.length === 0) {
    return {
      exposedRepos: new Set(),
      reachableRepos: new Set(),
      elapsedMs: 0,
      cypher: '',
      totalPaths: 0,
    };
  }

  const escape = (value: string) => value.replace(/'/g, "\\'");
  const maxLen = options.maxDepth + 2;
  const relTypes = BLAST_REL_TYPES.map((type) => `'${type}'`).join(', ');
  const sources = compromisedVersionKeys.map((key) => `'${escape(key)}'`).join(', ');
  const targets = repoKeys.map((key) => `'${escape(key)}'`).join(', ');

  const build = (pathCount: number, resultLimit: number) =>
    `CALL algo.MSpaths({sourceLabel: 'Version', sourceProperty: 'key', sourceValues: [${sources}], ` +
    `targetLabel: 'Repo', targetProperty: 'key', targetValues: [${targets}], pairwise: false, ` +
    `relTypes: [${relTypes}], relDirection: 'incoming', maxLen: ${maxLen}, ` +
    `pathCount: ${pathCount}, resultLimit: ${resultLimit}}) YIELD path RETURN path`;

  const result = await runPathProcedure(client, build, options, options.onDegrade);
  const paths = extractPaths(result.records);

  const reachableRepos = new Set<string>();
  for (const path of paths) {
    const last = path.nodes[path.nodes.length - 1];
    if (last?.labels.includes('Repo')) reachableRepos.add(str(last.properties.key));
  }

  // The traversal walks the global resolution graph, so it also reaches repos
  // that have upgraded away. Intersect with what current lockfiles actually
  // pin, for the same reason `blastRadius` does — otherwise a remediated repo
  // keeps counting as exposed. HydraDB's WHERE has no `IN`, so this is one
  // small query per compromised version rather than a single disjunction.
  const exposedRepos = new Set<string>();
  const pinQueries = await Promise.all(
    compromisedVersionKeys.map((key) =>
      client.query(
        'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version) ' +
          'WHERE v.key = $key AND s.is_current = true ' +
          'RETURN DISTINCT s.repo_key AS repo_key',
        { consistency: options.consistency, parameters: { key } },
      ),
    ),
  );
  for (const pinResult of pinQueries) {
    for (const record of pinResult.records) {
      const repoKey = str(record.repo_key);
      if (repoKey) exposedRepos.add(repoKey);
    }
  }

  return {
    exposedRepos,
    reachableRepos,
    elapsedMs: result.elapsedMs,
    cypher: result.cypher,
    totalPaths: paths.length,
  };
}

/**
 * "Which version of the dependency introduced the vulnerability?"
 *
 * Given a package and an advisory's affected set, report each version in
 * publish order and whether it falls inside the affected range — so the first
 * affected publish is visible rather than inferred.
 */
export interface VersionTimelineEntry {
  versionKey: string;
  versionString: string;
  publishedAt: number;
  affected: boolean;
  isCompromised: boolean;
  advisoryId: string;
  introducesVulnerability: boolean;
}

export function buildVersionTimeline(versions: VersionRef[]): VersionTimelineEntry[] {
  const ordered = [...versions].sort((a, b) => a.publishedAt - b.publishedAt);
  let seenAffected = false;
  return ordered.map((version) => {
    const affected = version.isCompromised || version.advisoryId !== '';
    const introduces = affected && !seenAffected;
    if (affected) seenAffected = true;
    return {
      versionKey: version.key,
      versionString: version.versionString,
      publishedAt: version.publishedAt,
      affected,
      isCompromised: version.isCompromised,
      advisoryId: version.advisoryId,
      introducesVulnerability: introduces,
    };
  });
}
