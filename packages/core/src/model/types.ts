/**
 * The Blast Radius property-graph model.
 *
 * Two HydraDB constraints shape every type here, and both were confirmed
 * against a live instance:
 *
 *  1. Node `id` must be a non-negative integer. An ecosystem-qualified name
 *     like `npm:left-pad` therefore cannot be the id; it lives in a `key`
 *     string property, and `IdRegistry` assigns the integer.
 *  2. Property values are integers, floats, booleans and strings only. There is
 *     no temporal type, so every timestamp is stored as epoch milliseconds —
 *     which is also what makes the Time Machine's `>=` / `<=` window filter a
 *     plain integer comparison the engine can index.
 *
 * There is also no `IS NULL` in HydraDB's `WHERE`, so "this version was never
 * compromised" is encoded as the sentinel `compromised_from = 0` alongside
 * `is_compromised = false` rather than as an absent property.
 */

export type Ecosystem = 'npm' | 'pypi';

export const NOT_COMPROMISED = 0;

export type LockfileSource =
  | 'package-lock.json'
  | 'yarn.lock'
  | 'pnpm-lock.yaml'
  | 'requirements.txt'
  | 'poetry.lock';

export interface PackageNode {
  key: string; // "npm:left-pad"
  name: string; // "left-pad"
  ecosystem: Ecosystem;
  /** Weekly downloads from the npm downloads API; 0 when unknown. */
  downloads: number;
  /** Epoch ms of the package's first publish; 0 when unknown. */
  created_at: number;
  /** Number of packages in this graph that depend on it — the "top dependency"
   *  ranking the typosquat check is scoped against. */
  dependent_count: number;
}

export interface VersionNode {
  key: string; // "npm:left-pad@3.4.1"
  package_key: string; // "npm:left-pad"
  package_name: string; // "left-pad" (denormalised for single-hop reads)
  ecosystem: Ecosystem;
  version_string: string; // "3.4.1"
  published_at: number; // epoch ms
  is_compromised: boolean;
  compromised_from: number; // epoch ms, or NOT_COMPROMISED
  compromised_to: number; // epoch ms, or NOT_COMPROMISED
  /** OSV/GHSA advisory id when this version is known-vulnerable, else "". */
  advisory_id: string;
}

export interface MaintainerNode {
  key: string; // "npm:stevemao"
  username: string;
  /** Registry emails are public metadata, but they are still PII; only a
   *  truncated SHA-256 is stored so the graph never carries a raw address. */
  email_hash: string;
  ecosystem: Ecosystem;
}

export interface OrgNode {
  key: string; // "acme-corp"
  name: string;
}

export interface RepoNode {
  key: string; // "acme-corp/payments-service"
  org_key: string;
  name: string; // "payments-service"
  language: string;
  lockfile_source: LockfileSource;
}

export interface LockfileSnapshotNode {
  key: string; // "acme-corp/payments-service@2026-08-14T09:03:12Z"
  repo_key: string;
  repo_name: string; // denormalised: lets Time Machine answer in one hop
  captured_at: number; // epoch ms
  /** Epoch ms at which a later snapshot replaced this one, or 0 if current. */
  superseded_at: number;
  is_current: boolean;
  source: LockfileSource;
  commit_sha: string;
}

export interface DependsOnEdge {
  from_version_key: string;
  to_package_key: string;
  range: string; // "^1.0.0"
  kind: 'prod' | 'dev' | 'peer' | 'optional';
}

export interface ResolvedToEdge {
  from_version_key: string;
  to_version_key: string;
}

export interface MaintainsEdge {
  maintainer_key: string;
  package_key: string;
}

/**
 * A lockfile pins its *entire* resolved tree, not just the packages the
 * manifest names, so `RESOLVED` is emitted for every entry. That completeness
 * is exactly what the Time Machine needs: "this lockfile pinned this precise
 * version" has to be a single-hop fact.
 *
 * It is the wrong edge to traverse for a blast radius, though. Because every
 * transitive package is also pinned directly, a shortest-path traversal would
 * always take the one-hop `RESOLVED` shortcut and report every exposure as
 * depth 1 — losing the dependency chain that explains *why* a repo is exposed.
 *
 * So direct dependencies additionally get a `RESOLVED_DIRECT` edge. Blast
 * radius walks `RESOLVED_TO` + `RESOLVED_DIRECT`, which forces paths in through
 * a package the repo actually asked for and then down the real dependency
 * chain. Both edges are honest; they answer different questions.
 */
export interface ResolvedEdge {
  snapshot_key: string;
  version_key: string;
  /** True when the snapshot lists this package as a direct dependency. */
  direct: boolean;
}

export interface HasSnapshotEdge {
  repo_key: string;
  snapshot_key: string;
}

export interface NameSimilarEdge {
  from_package_key: string;
  to_package_key: string;
  distance: number;
  /** Weighted score that also accounts for keyboard adjacency. */
  score: number;
  reason: string;
}

/**
 * The incident the generated lockfile history was built around.
 *
 * Recorded in the snapshot so `make demo` and the documented examples always
 * name the same package: which version gets seeded depends on what the crawl
 * actually returned, so hard-coding it anywhere else would drift.
 */
export interface IncidentSeed {
  scenario: string;
  version_key: string;
  package_key: string;
  replacement_version_key: string;
  from: number;
  to: number;
}

/** The complete vendored graph, as written to `data/snapshot/`. */
export interface GraphSnapshot {
  generated_at: string;
  ecosystems: Ecosystem[];
  incident: IncidentSeed | null;
  packages: PackageNode[];
  versions: VersionNode[];
  maintainers: MaintainerNode[];
  orgs: OrgNode[];
  repos: RepoNode[];
  snapshots: LockfileSnapshotNode[];
  depends_on: DependsOnEdge[];
  resolved_to: ResolvedToEdge[];
  maintains: MaintainsEdge[];
  resolved: ResolvedEdge[];
  has_snapshot: HasSnapshotEdge[];
  name_similar_to: NameSimilarEdge[];
  advisories: AdvisoryRecord[];
}

/**
 * A real OSV.dev / GitHub Security Advisory record.
 *
 * Loaded as its own node with `AFFECTS` edges to every version it covers, so
 * severity is a graph property rather than a string on the side. That is what
 * lets exposure be ranked by real advisory severity instead of by depth alone.
 */
export interface AdvisoryRecord {
  id: string;
  package_key: string;
  summary: string;
  published: number;
  severity: string;
  /** Half-open [introduced, fixed) semver ranges from the advisory. */
  ranges: Array<{ introduced: string; fixed: string | null }>;
  affected_version_keys: string[];
}

export const NODE_LABELS = [
  'Package',
  'Version',
  'Maintainer',
  'Org',
  'Repo',
  'LockfileSnapshot',
  'Advisory',
] as const;

export const EDGE_TYPES = [
  'DEPENDS_ON',
  'RESOLVED_TO',
  'MAINTAINS',
  'RESOLVED',
  'RESOLVED_DIRECT',
  'HAS_SNAPSHOT',
  'NAME_SIMILAR_TO',
  'AFFECTS',
] as const;

export type NodeLabel = (typeof NODE_LABELS)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];

// --- key helpers ------------------------------------------------------------

export const packageKey = (ecosystem: Ecosystem, name: string): string => `${ecosystem}:${name}`;

export const versionKey = (ecosystem: Ecosystem, name: string, version: string): string =>
  `${ecosystem}:${name}@${version}`;

export const maintainerKey = (ecosystem: Ecosystem, username: string): string =>
  `${ecosystem}:${username}`;

export const repoKey = (org: string, repo: string): string => `${org}/${repo}`;

export const snapshotKey = (repoKeyValue: string, capturedAt: number): string =>
  `${repoKeyValue}@${new Date(capturedAt).toISOString()}`;

/** Split "npm:left-pad@3.4.1" into its parts. Scoped names ("npm:@babel/core")
 *  contain an `@` of their own, so the version separator is the *last* one. */
export function parseVersionKey(key: string): {
  ecosystem: Ecosystem;
  name: string;
  version: string;
} {
  const colon = key.indexOf(':');
  if (colon === -1) throw new Error(`malformed version key: ${key}`);
  const ecosystem = key.slice(0, colon) as Ecosystem;
  const rest = key.slice(colon + 1);
  const at = rest.lastIndexOf('@');
  if (at <= 0) throw new Error(`malformed version key (no version): ${key}`);
  return { ecosystem, name: rest.slice(0, at), version: rest.slice(at + 1) };
}

/** Split "npm:@babel/core" into ecosystem and name. */
export function parsePackageKey(key: string): { ecosystem: Ecosystem; name: string } {
  const colon = key.indexOf(':');
  if (colon === -1) throw new Error(`malformed package key: ${key}`);
  return { ecosystem: key.slice(0, colon) as Ecosystem, name: key.slice(colon + 1) };
}
