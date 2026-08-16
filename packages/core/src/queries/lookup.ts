/**
 * Entity lookups.
 *
 * Every lookup goes through a string `key` property rather than the integer
 * node id, because the id is an internal allocation detail while the key is
 * what a user types (`npm:left-pad@3.4.1`). HydraDB maintains a property index
 * automatically, so these resolve without any declared schema.
 */
import type { CellValue, HydraClient, QueryOptions } from '../hydra/client.js';
import type { Ecosystem, LockfileSource } from '../model/types.js';

const asNumber = (value: CellValue | undefined): number =>
  typeof value === 'number' ? value : 0;
const asString = (value: CellValue | undefined): string =>
  typeof value === 'string' ? value : '';
const asBoolean = (value: CellValue | undefined): boolean => value === true;

export interface VersionRef {
  id: number;
  key: string;
  packageKey: string;
  packageName: string;
  versionString: string;
  ecosystem: Ecosystem;
  publishedAt: number;
  isCompromised: boolean;
  compromisedFrom: number;
  compromisedTo: number;
  advisoryId: string;
}

export interface PackageRef {
  id: number;
  key: string;
  name: string;
  ecosystem: Ecosystem;
  downloads: number;
  createdAt: number;
  dependentCount: number;
}

export interface RepoRef {
  id: number;
  key: string;
  name: string;
  orgKey: string;
  language: string;
  lockfileSource: LockfileSource;
}

export async function findVersion(
  client: HydraClient,
  key: string,
  options?: QueryOptions,
): Promise<VersionRef | null> {
  const result = await client.query(
    'MATCH (v:Version) WHERE v.key = $key ' +
      'RETURN v.id AS id, v.key AS key, v.package_key AS package_key, v.package_name AS package_name, ' +
      'v.version_string AS version_string, v.ecosystem AS ecosystem, v.published_at AS published_at, ' +
      'v.is_compromised AS is_compromised, v.compromised_from AS compromised_from, ' +
      'v.compromised_to AS compromised_to, v.advisory_id AS advisory_id LIMIT 1',
    { ...options, parameters: { ...options?.parameters, key } },
  );
  const record = result.records[0];
  if (!record) return null;
  return {
    id: asNumber(record.id),
    key: asString(record.key),
    packageKey: asString(record.package_key),
    packageName: asString(record.package_name),
    versionString: asString(record.version_string),
    ecosystem: asString(record.ecosystem) as Ecosystem,
    publishedAt: asNumber(record.published_at),
    isCompromised: asBoolean(record.is_compromised),
    compromisedFrom: asNumber(record.compromised_from),
    compromisedTo: asNumber(record.compromised_to),
    advisoryId: asString(record.advisory_id),
  };
}

export async function findPackage(
  client: HydraClient,
  key: string,
  options?: QueryOptions,
): Promise<PackageRef | null> {
  const result = await client.query(
    'MATCH (p:Package) WHERE p.key = $key ' +
      'RETURN p.id AS id, p.key AS key, p.name AS name, p.ecosystem AS ecosystem, ' +
      'p.downloads AS downloads, p.created_at AS created_at, p.dependent_count AS dependent_count LIMIT 1',
    { ...options, parameters: { ...options?.parameters, key } },
  );
  const record = result.records[0];
  if (!record) return null;
  return {
    id: asNumber(record.id),
    key: asString(record.key),
    name: asString(record.name),
    ecosystem: asString(record.ecosystem) as Ecosystem,
    downloads: asNumber(record.downloads),
    createdAt: asNumber(record.created_at),
    dependentCount: asNumber(record.dependent_count),
  };
}

/** All versions of a package, newest first. Powers `--which-version`. */
export async function listVersionsOfPackage(
  client: HydraClient,
  packageKey: string,
  options?: QueryOptions,
): Promise<VersionRef[]> {
  const result = await client.query(
    'MATCH (v:Version) WHERE v.package_key = $package_key ' +
      'RETURN v.id AS id, v.key AS key, v.package_key AS package_key, v.package_name AS package_name, ' +
      'v.version_string AS version_string, v.ecosystem AS ecosystem, v.published_at AS published_at, ' +
      'v.is_compromised AS is_compromised, v.compromised_from AS compromised_from, ' +
      'v.compromised_to AS compromised_to, v.advisory_id AS advisory_id ' +
      'ORDER BY published_at DESC',
    { ...options, parameters: { ...options?.parameters, package_key: packageKey } },
  );
  return result.records.map((record) => ({
    id: asNumber(record.id),
    key: asString(record.key),
    packageKey: asString(record.package_key),
    packageName: asString(record.package_name),
    versionString: asString(record.version_string),
    ecosystem: asString(record.ecosystem) as Ecosystem,
    publishedAt: asNumber(record.published_at),
    isCompromised: asBoolean(record.is_compromised),
    compromisedFrom: asNumber(record.compromised_from),
    compromisedTo: asNumber(record.compromised_to),
    advisoryId: asString(record.advisory_id),
  }));
}

export async function listRepos(
  client: HydraClient,
  orgKey?: string,
  options?: QueryOptions,
): Promise<RepoRef[]> {
  const filter = orgKey ? 'WHERE r.org_key = $org_key ' : '';
  const result = await client.query(
    `MATCH (r:Repo) ${filter}` +
      'RETURN r.id AS id, r.key AS key, r.name AS name, r.org_key AS org_key, ' +
      'r.language AS language, r.lockfile_source AS lockfile_source ORDER BY key',
    { ...options, parameters: { ...options?.parameters, ...(orgKey ? { org_key: orgKey } : {}) } },
  );
  return result.records.map((record) => ({
    id: asNumber(record.id),
    key: asString(record.key),
    name: asString(record.name),
    orgKey: asString(record.org_key),
    language: asString(record.language),
    lockfileSource: asString(record.lockfile_source) as LockfileSource,
  }));
}

/** Resolve a repo by bare name ("payments-service") or full key. */
export async function resolveRepoKeys(
  client: HydraClient,
  names: string[],
  orgKey: string,
): Promise<{ resolved: RepoRef[]; missing: string[] }> {
  const all = await listRepos(client, orgKey);
  const byName = new Map(all.map((repo) => [repo.name, repo]));
  const byKey = new Map(all.map((repo) => [repo.key, repo]));
  const resolved: RepoRef[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const match = byKey.get(name) ?? byName.get(name);
    if (match) resolved.push(match);
    else missing.push(name);
  }
  return { resolved, missing };
}

/** Every version currently marked compromised. */
export async function listCompromisedVersions(
  client: HydraClient,
  options?: QueryOptions,
): Promise<VersionRef[]> {
  const result = await client.query(
    'MATCH (v:Version) WHERE v.is_compromised = true ' +
      'RETURN v.id AS id, v.key AS key, v.package_key AS package_key, v.package_name AS package_name, ' +
      'v.version_string AS version_string, v.ecosystem AS ecosystem, v.published_at AS published_at, ' +
      'v.is_compromised AS is_compromised, v.compromised_from AS compromised_from, ' +
      'v.compromised_to AS compromised_to, v.advisory_id AS advisory_id ORDER BY key',
    options,
  );
  return result.records.map((record) => ({
    id: asNumber(record.id),
    key: asString(record.key),
    packageKey: asString(record.package_key),
    packageName: asString(record.package_name),
    versionString: asString(record.version_string),
    ecosystem: asString(record.ecosystem) as Ecosystem,
    publishedAt: asNumber(record.published_at),
    isCompromised: asBoolean(record.is_compromised),
    compromisedFrom: asNumber(record.compromised_from),
    compromisedTo: asNumber(record.compromised_to),
    advisoryId: asString(record.advisory_id),
  }));
}

export interface GraphStats {
  packages: number;
  versions: number;
  maintainers: number;
  repos: number;
  snapshots: number;
  resolvedToEdges: number;
  resolvedEdges: number;
  maintainsEdges: number;
  similarEdges: number;
}

export async function graphStats(client: HydraClient): Promise<GraphStats> {
  const count = async (pattern: string): Promise<number> => {
    const result = await client.query(`MATCH ${pattern} RETURN count(*) AS n`);
    return asNumber(result.records[0]?.n);
  };
  const [
    packages,
    versions,
    maintainers,
    repos,
    snapshots,
    resolvedToEdges,
    resolvedEdges,
    maintainsEdges,
    similarEdges,
  ] = await Promise.all([
    count('(n:Package)'),
    count('(n:Version)'),
    count('(n:Maintainer)'),
    count('(n:Repo)'),
    count('(n:LockfileSnapshot)'),
    count('()-[r:RESOLVED_TO]->()'),
    count('()-[r:RESOLVED]->()'),
    count('()-[r:MAINTAINS]->()'),
    count('()-[r:NAME_SIMILAR_TO]->()'),
  ]);
  return {
    packages,
    versions,
    maintainers,
    repos,
    snapshots,
    resolvedToEdges,
    resolvedEdges,
    maintainsEdges,
    similarEdges,
  };
}

/**
 * What the user probably meant, when a version key is not in the graph.
 *
 * A mistyped or wrongly-formatted key is the single most likely thing anyone
 * gets wrong here — the format is `ecosystem:package@version` and nothing about
 * `debug@4.4.3` announces that the `npm:` prefix is required. Answering "not
 * found" and stopping makes the tool feel broken when the graph is fine.
 *
 * Three cheap passes, in order of how likely each is to be the real intent:
 * the same key with an ecosystem prefix added, other versions of that package,
 * and finally a prefix search on the package name.
 */
export async function suggestVersions(
  client: HydraClient,
  key: string,
  limit = 6,
): Promise<string[]> {
  const suggestions: string[] = [];
  const add = (value: CellValue | undefined) => {
    const text = asString(value);
    if (text && !suggestions.includes(text)) suggestions.push(text);
  };

  // 1. The key is right but the ecosystem prefix is missing.
  if (!key.includes(':')) {
    for (const ecosystem of ['npm', 'pypi']) {
      const result = await client.query(
        'MATCH (v:Version) WHERE v.key = $key RETURN v.key AS key LIMIT 1',
        { parameters: { key: `${ecosystem}:${key}` } },
      );
      result.records.forEach((record) => add(record.key));
    }
  }

  // 2. The package exists but that version does not.
  const at = key.lastIndexOf('@');
  const packageKey = at > 0 ? key.slice(0, at) : key;
  for (const candidate of packageKey.includes(':')
    ? [packageKey]
    : [`npm:${packageKey}`, `pypi:${packageKey}`]) {
    const result = await client.query(
      'MATCH (v:Version) WHERE v.package_key = $pkg ' +
        'RETURN v.key AS key, v.published_at AS published_at ORDER BY published_at DESC LIMIT $limit',
      { parameters: { pkg: candidate, limit } },
    );
    result.records.forEach((record) => add(record.key));
    if (suggestions.length >= limit) return suggestions.slice(0, limit);
  }

  // 3. Fall back to a prefix search on the bare package name.
  const bare = packageKey.includes(':') ? packageKey.slice(packageKey.indexOf(':') + 1) : packageKey;
  if (bare.length >= 2) {
    const result = await client.query(
      'MATCH (p:Package) WHERE p.name STARTS WITH $prefix ' +
        'RETURN p.key AS key ORDER BY p.dependent_count DESC LIMIT $limit',
      { parameters: { prefix: bare, limit } },
    );
    result.records.forEach((record) => add(record.key));
  }

  return suggestions.slice(0, limit);
}
