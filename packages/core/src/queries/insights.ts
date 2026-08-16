/**
 * Higher-order questions built on the traversal primitives.
 *
 * Everything here is a graph question that a scanner cannot express, which is
 * the point: the value of holding the dependency graph in a real engine is that
 * "what would happen if" and "why is this here" become ordinary queries.
 */
import type { HydraClient, QueryOptions, GraphPath } from '../hydra/client.js';
import { blastRadius, type BlastRadiusOptions, type ExposedRepo } from './blastRadius.js';
import { findVersion, type VersionRef } from './lookup.js';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

// --- severity ---------------------------------------------------------------

/**
 * OSV severities arrive as words (`CRITICAL`) or as a CVSS vector string.
 * Both are mapped onto one scale so exposure can be ordered.
 */
export function severityWeight(severity: string): number {
  const s = severity.toUpperCase();
  if (s.includes('CRITICAL')) return 1.0;
  if (s.includes('HIGH')) return 0.75;
  if (s.includes('MODERATE') || s.includes('MEDIUM')) return 0.5;
  if (s.includes('LOW')) return 0.25;
  return 0.4; // UNKNOWN — not zero: an unrated advisory is still an advisory
}

export interface RankedExposure extends ExposedRepo {
  /** 0..1. Higher means "fix this one first". */
  priority: number;
  /** The reasoning, so the ranking is auditable rather than a magic number. */
  factors: { severity: number; proximity: number; directness: number; reach: number };
  advisoryId: string;
  advisorySeverity: string;
}

export interface PrioritisedReport {
  source: VersionRef;
  ranked: RankedExposure[];
  advisoryId: string;
  advisorySeverity: string;
  elapsedMs: number;
  cypher: string;
}

/**
 * Order exposed repositories by how urgently they need attention.
 *
 * Depth alone is a poor proxy: a critical advisory three hops away in a service
 * that ships to production matters more than a low-severity one pinned
 * directly by a docs site. The score combines the real advisory severity from
 * the graph, how close the compromised package sits to the repo, whether it is
 * a direct dependency, and how much of the repo's tree it touches.
 */
export async function prioritiseExposure(
  client: HydraClient,
  source: VersionRef,
  options: BlastRadiusOptions,
): Promise<PrioritisedReport> {
  const startedAt = performance.now();

  const cypher =
    'MATCH (a:Advisory)-[:AFFECTS]->(v:Version {id: $version_id}) ' +
    'RETURN a.key AS key, a.severity AS severity, a.summary AS summary ORDER BY key LIMIT 1';

  const [report, advisory] = await Promise.all([
    blastRadius(client, source, options),
    client.query(cypher, {
      consistency: options.consistency,
      parameters: { version_id: source.id },
    }),
  ]);

  const advisoryId = str(advisory.records[0]?.key);
  const advisorySeverity = str(advisory.records[0]?.severity) || 'UNKNOWN';
  const severity = advisoryId ? severityWeight(advisorySeverity) : 0.6;

  const maxDepth = Math.max(1, ...report.exposedRepos.map((e) => e.depth));

  const ranked: RankedExposure[] = report.exposedRepos.map((exposure) => {
    const proximity = 1 - (exposure.depth - 1) / Math.max(1, maxDepth);
    const directness = exposure.direct ? 1 : 0.5;
    // A repo reached by several distinct chains is more entangled with the
    // compromised package than one reached by a single path.
    const reach = Math.min(1, exposure.chain.length / 5);
    const priority = severity * 0.45 + proximity * 0.3 + directness * 0.15 + reach * 0.1;
    return {
      ...exposure,
      priority: Number(priority.toFixed(4)),
      factors: {
        severity: Number(severity.toFixed(3)),
        proximity: Number(proximity.toFixed(3)),
        directness,
        reach: Number(reach.toFixed(3)),
      },
      advisoryId,
      advisorySeverity,
    };
  });

  ranked.sort((a, b) => b.priority - a.priority || a.depth - b.depth);

  return {
    source,
    ranked,
    advisoryId,
    advisorySeverity,
    elapsedMs: report.elapsedMs + advisory.elapsedMs,
    cypher,
  };
}

// --- preflight --------------------------------------------------------------

export interface PreflightEntry {
  packageKey: string;
  packageName: string;
  versionKey: string;
  exposedRepos: number;
  maxDepth: number;
  downloads: number;
  maintainers: number;
  /** 0..1 relative to the worst package in the run. */
  damage: number;
}

export interface PreflightReport {
  entries: PreflightEntry[];
  candidatesTested: number;
  elapsedMs: number;
  cypher: string;
}

/**
 * "What would happen if each of our dependencies were compromised tomorrow?"
 *
 * The product is otherwise reactive — it needs something to already be
 * compromised. This inverts it: for each of the org's most-depended-on
 * packages, run the real blast-radius traversal against the version currently
 * pinned and rank by how much damage a compromise would do. The output is a
 * list of the packages worth watching *before* anything happens.
 */
export async function preflight(
  client: HydraClient,
  options: BlastRadiusOptions & { limit?: number; onProgress?: (done: number, total: number) => void },
): Promise<PreflightReport> {
  const startedAt = performance.now();
  const limit = options.limit ?? 15;

  // Candidates: the versions current lockfiles actually pin, most widely
  // depended-on first. Anything not in a live lockfile cannot hurt us today.
  const cypher =
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version) WHERE s.is_current = true ' +
    'RETURN DISTINCT v.key AS version_key, v.package_key AS package_key, ' +
    'v.package_name AS package_name';

  const candidates = await client.query(cypher, { consistency: options.consistency });

  // Weight by how many current lockfiles pin it — a good proxy for blast size
  // and far cheaper than traversing every one of ~7000 pinned versions.
  const pinCount = new Map<string, number>();
  for (const record of candidates.records) {
    const key = str(record.version_key);
    pinCount.set(key, (pinCount.get(key) ?? 0) + 1);
  }

  const meta = new Map(
    candidates.records.map((r) => [
      str(r.version_key),
      { packageKey: str(r.package_key), packageName: str(r.package_name) },
    ]),
  );

  const shortlist = [...new Set(candidates.records.map((r) => str(r.version_key)))]
    .filter(Boolean)
    .sort((a, b) => (pinCount.get(b) ?? 0) - (pinCount.get(a) ?? 0))
    .slice(0, limit);

  const entries: PreflightEntry[] = [];
  let done = 0;

  for (const versionKey of shortlist) {
    const version = await findVersion(client, versionKey, { consistency: options.consistency });
    done += 1;
    options.onProgress?.(done, shortlist.length);
    if (!version) continue;

    const report = await blastRadius(client, version, options);
    const info = meta.get(versionKey);

    const pkg = await client.query(
      'MATCH (p:Package) WHERE p.key = $key RETURN p.downloads AS downloads LIMIT 1',
      { consistency: options.consistency, parameters: { key: version.packageKey } },
    );
    const maintainers = await client.query(
      'MATCH (m:Maintainer)-[:MAINTAINS]->(p:Package) WHERE p.key = $key RETURN count(*) AS n',
      { consistency: options.consistency, parameters: { key: version.packageKey } },
    );

    entries.push({
      packageKey: version.packageKey,
      packageName: info?.packageName ?? version.packageName,
      versionKey,
      exposedRepos: report.exposedRepos.length,
      maxDepth: Math.max(0, ...report.exposedRepos.map((e) => e.depth)),
      downloads: num(pkg.records[0]?.downloads),
      maintainers: num(maintainers.records[0]?.n),
      damage: 0,
    });
  }

  const worst = Math.max(1, ...entries.map((e) => e.exposedRepos));
  for (const entry of entries) entry.damage = Number((entry.exposedRepos / worst).toFixed(3));
  entries.sort((a, b) => b.exposedRepos - a.exposedRepos || b.downloads - a.downloads);

  return {
    entries,
    candidatesTested: shortlist.length,
    elapsedMs: performance.now() - startedAt,
    cypher,
  };
}

// --- path explain -----------------------------------------------------------

export interface PathExplanation {
  from: string;
  to: string;
  found: boolean;
  hops: number;
  chain: Array<{ key: string; label: string; kind: string }>;
  chainText: string;
  elapsedMs: number;
  cypher: string;
}

/**
 * "Why is this package in my tree at all?"
 *
 * `algo.SPpaths` — paths between exactly one source and one target — is the
 * right primitive here and is otherwise unused by the product. Given a repo and
 * any package version it ships, this returns the single shortest chain that
 * pulled it in.
 */
export async function explainPath(
  client: HydraClient,
  repoKey: string,
  versionKey: string,
  options: BlastRadiusOptions,
): Promise<PathExplanation> {
  const repo = await client.query(
    'MATCH (r:Repo) WHERE r.key = $key RETURN r.id AS id LIMIT 1',
    { consistency: options.consistency, parameters: { key: repoKey } },
  );
  const version = await client.query(
    'MATCH (v:Version) WHERE v.key = $key RETURN v.id AS id LIMIT 1',
    { consistency: options.consistency, parameters: { key: versionKey } },
  );

  const repoId = num(repo.records[0]?.id);
  const versionId = num(version.records[0]?.id);
  if (!repoId) throw new Error(`repo not found: ${repoKey}`);
  if (!versionId) throw new Error(`version not found: ${versionKey}`);

  const maxLen = options.maxDepth + 2;
  const cypher =
    `CALL algo.SPpaths({sourceNode: ${repoId}, targetNode: ${versionId}, ` +
    `relTypes: ['HAS_SNAPSHOT', 'RESOLVED_DIRECT', 'RESOLVED_TO'], relDirection: 'outgoing', ` +
    `maxLen: ${maxLen}, pathCount: 1}) YIELD path RETURN path`;

  const result = await client.query(cypher, { consistency: options.consistency });
  const path = result.records[0]?.path as GraphPath | undefined;

  if (!path) {
    return {
      from: repoKey,
      to: versionKey,
      found: false,
      hops: 0,
      chain: [],
      chainText: '',
      elapsedMs: result.elapsedMs,
      cypher,
    };
  }

  const chain = path.nodes
    .map((node) => {
      const kind = node.labels.includes('Repo')
        ? 'repo'
        : node.labels.includes('LockfileSnapshot')
          ? 'lockfile'
          : 'version';
      const label =
        kind === 'version'
          ? `${str(node.properties.package_name)}@${str(node.properties.version_string)}`
          : kind === 'repo'
            ? str(node.properties.name)
            : 'lockfile';
      return { key: str(node.properties.key), label, kind };
    })
    .filter((link) => link.kind !== 'lockfile');

  return {
    from: repoKey,
    to: versionKey,
    found: true,
    hops: path.relationships.filter((r) => r.type === 'RESOLVED_TO').length,
    chain,
    chainText: chain.map((c) => c.label).join(' -> '),
    elapsedMs: result.elapsedMs,
    cypher,
  };
}

// --- maintainer blast radius ------------------------------------------------

export interface MaintainerRadius {
  maintainer: string;
  packages: Array<{ key: string; name: string }>;
  exposedRepos: string[];
  affectedVersions: number;
  elapsedMs: number;
  cypher: string;
}

/**
 * "If this maintainer's account is phished, what burns?"
 *
 * The unit of compromise in a supply-chain attack is usually an account, not a
 * package. This walks `MAINTAINS` to everything the account can publish, then
 * asks which of the org's repos currently pin any version of those packages.
 */
export async function maintainerBlastRadius(
  client: HydraClient,
  username: string,
  options: BlastRadiusOptions,
): Promise<MaintainerRadius> {
  const startedAt = performance.now();

  const cypher =
    'MATCH (m:Maintainer)-[:MAINTAINS]->(p:Package) WHERE m.username = $username ' +
    'RETURN p.key AS package_key, p.name AS name ORDER BY name';

  const owned = await client.query(cypher, {
    consistency: options.consistency,
    parameters: { username },
  });
  const packages = owned.records.map((r) => ({
    key: str(r.package_key),
    name: str(r.name),
  }));
  if (packages.length === 0) {
    throw new Error(`no maintainer named "${username}" in the graph`);
  }

  const ownedKeys = new Set(packages.map((p) => p.key));

  // One pass over every current pin, intersected in memory — HydraDB has no
  // `IN`, and one query per package would be dozens of round trips.
  const pinned = await client.query(
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version) WHERE s.is_current = true ' +
      'RETURN DISTINCT s.repo_name AS repo_name, v.package_key AS package_key',
    { consistency: options.consistency },
  );

  const exposed = new Set<string>();
  let affectedVersions = 0;
  for (const record of pinned.records) {
    if (!ownedKeys.has(str(record.package_key))) continue;
    affectedVersions += 1;
    const repo = str(record.repo_name);
    if (repo) exposed.add(repo);
  }

  return {
    maintainer: username,
    packages,
    exposedRepos: [...exposed].sort(),
    affectedVersions,
    elapsedMs: performance.now() - startedAt,
    cypher,
  };
}

// --- advisories -------------------------------------------------------------

export interface AdvisoryView {
  id: string;
  packageKey: string;
  summary: string;
  severity: string;
  published: number;
  affectedCount: number;
  /** Repos whose *current* lockfile pins an affected version. */
  exposedRepos: string[];
  /**
   * Repos that pinned an affected version in a *superseded* lockfile and have
   * since upgraded away. Clean today, and they shipped it — which is the whole
   * argument for keeping lockfile history, applied to real CVEs.
   */
  historicalRepos: string[];
}

/** Every real advisory in the graph, with the repos each one currently reaches. */
export async function advisories(
  client: HydraClient,
  options: { consistency?: QueryOptions['consistency'] } = {},
): Promise<{ advisories: AdvisoryView[]; elapsedMs: number; cypher: string }> {
  const cypher =
    'MATCH (a:Advisory)-[:AFFECTS]->(v:Version) ' +
    'RETURN a.key AS key, a.package_key AS package_key, a.summary AS summary, ' +
    'a.severity AS severity, a.published AS published, v.key AS version_key ' +
    'ORDER BY key';

  const [rows, pinned] = await Promise.all([
    client.query(cypher, options),
    // Both tenses in one read. A current-state scanner sees only the first, and
    // on this dataset that means every advisory reports zero — while six
    // services did in fact ship an affected version at some point.
    client.query(
      'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version) ' +
        'RETURN DISTINCT s.repo_name AS repo_name, v.key AS version_key, ' +
        's.is_current AS is_current',
      options,
    ),
  ]);

  const reposByVersion = new Map<string, Set<string>>();
  const historicalByVersion = new Map<string, Set<string>>();
  for (const record of pinned.records) {
    const key = str(record.version_key);
    const target = record.is_current === true ? reposByVersion : historicalByVersion;
    const set = target.get(key) ?? new Set<string>();
    set.add(str(record.repo_name));
    target.set(key, set);
  }

  const byId = new Map<string, AdvisoryView>();
  for (const record of rows.records) {
    const id = str(record.key);
    const view = byId.get(id) ?? {
      id,
      packageKey: str(record.package_key),
      summary: str(record.summary),
      severity: str(record.severity),
      published: num(record.published),
      affectedCount: 0,
      exposedRepos: [],
      historicalRepos: [],
    };
    view.affectedCount += 1;
    const versionKey = str(record.version_key);
    const repos = reposByVersion.get(versionKey);
    if (repos) for (const repo of repos) if (!view.exposedRepos.includes(repo)) view.exposedRepos.push(repo);
    const past = historicalByVersion.get(versionKey);
    if (past) {
      for (const repo of past) {
        // A repo exposed right now is not also "historical" — that would double
        // count it and overstate the cleanup.
        if (!view.exposedRepos.includes(repo) && !view.historicalRepos.includes(repo)) {
          view.historicalRepos.push(repo);
        }
      }
    }
    byId.set(id, view);
  }

  const list = [...byId.values()].sort(
    (a, b) =>
      b.exposedRepos.length - a.exposedRepos.length ||
      b.historicalRepos.length - a.historicalRepos.length ||
      severityWeight(b.severity) - severityWeight(a.severity),
  );
  for (const view of list) {
    view.exposedRepos.sort();
    view.historicalRepos.sort();
  }

  return { advisories: list, elapsedMs: rows.elapsedMs + pinned.elapsedMs, cypher };
}

/* -------------------------------------------------------------------------- */
/* Arm a real advisory                                                        */
/* -------------------------------------------------------------------------- */

export interface AdvisoryArming {
  advisoryId: string;
  summary: string;
  severity: string;
  published: number;
  from: number;
  to: number;
  /** Every version the advisory's AFFECTS edges point at. */
  versions: Array<{ id: number; key: string }>;
}

/**
 * Resolve a real OSV advisory into the set of versions it affects.
 *
 * The demo's headline incident is a hand-marked window, which is the right
 * shape for a *malicious publish* — a package that was bad for six minutes.
 * A vulnerability disclosure is a different shape: every affected version was
 * vulnerable from the moment it was published, and stays so until it is
 * upgraded away from. So this is the other half of the workflow — "GHSA-xxx
 * just dropped, mark everything it touches" — driven by the graph's own
 * `AFFECTS` edges rather than by anything typed in by hand.
 *
 * The window defaults to the advisory's own publication date through now, which
 * is the honest reading of "this has been exploitable since disclosure". Both
 * ends are overridable.
 */
export async function resolveAdvisory(
  client: HydraClient,
  advisoryId: string,
  options: { from?: number; to?: number } = {},
): Promise<AdvisoryArming | null> {
  const meta = await client.query(
    'MATCH (a:Advisory) WHERE a.key = $key ' +
      'RETURN a.key AS key, a.summary AS summary, a.severity AS severity, ' +
      'a.published AS published LIMIT 1',
    { parameters: { key: advisoryId } },
  );
  const record = meta.records[0];
  if (!record) return null;

  const affected = await client.query(
    'MATCH (a:Advisory)-[:AFFECTS]->(v:Version) WHERE a.key = $key ' +
      'RETURN v.id AS id, v.key AS key ORDER BY key',
    { parameters: { key: advisoryId } },
  );

  const published = typeof record.published === 'number' ? record.published : 0;

  return {
    advisoryId: typeof record.key === 'string' ? record.key : advisoryId,
    summary: typeof record.summary === 'string' ? record.summary : '',
    severity: typeof record.severity === 'string' ? record.severity : 'UNKNOWN',
    published,
    from: options.from ?? published,
    to: options.to ?? Date.now(),
    versions: affected.records
      .map((row) => ({
        id: typeof row.id === 'number' ? row.id : -1,
        key: typeof row.key === 'string' ? row.key : '',
      }))
      .filter((entry) => entry.id >= 0 && entry.key !== ''),
  };
}
