/**
 * Builds the real dependency graph from registry metadata.
 *
 * The crawl is a breadth-first expansion from the curated seed list: fetch a
 * package, record its versions and maintainers, then follow its declared
 * dependencies to the next level. Declared dependencies give `DEPENDS_ON`
 * edges (a version *range*, unresolved); running each range through semver
 * against the versions actually published gives `RESOLVED_TO` edges, which are
 * the concrete ones the blast-radius traversal walks.
 *
 * Both edge types are kept deliberately. A range is what a manifest says; a
 * resolution is what a lockfile did. Conflating them is exactly the mistake
 * that makes a scanner unable to answer "who actually shipped the bad build".
 */
import semver from 'semver';

import type {
  AdvisoryRecord,
  DependsOnEdge,
  Ecosystem,
  MaintainerNode,
  MaintainsEdge,
  PackageNode,
  ResolvedToEdge,
  VersionNode,
} from '../model/types.js';
import { NOT_COMPROMISED, packageKey, versionKey } from '../model/types.js';
import type { ReducedPackument, RegistryClient } from './registry.js';
import { seedsFor } from './seeds.js';

export interface CrawlOptions {
  ecosystem: Ecosystem;
  seedCount: number;
  maxDepth: number;
  fullMetadataDepth: number;
  /** Only the newest N versions of each package get resolved dependency edges.
   *  Every retained version still becomes a node; this bounds edge count, which
   *  is what actually drives traversal cost. */
  resolveVersionsPerPackage: number;
  onProgress?: (info: { fetched: number; queued: number; depth: number; name: string }) => void;
  onDepthStart?: (info: { depth: number; frontier: number; full: boolean }) => void;
}

export interface CrawlResult {
  packages: PackageNode[];
  versions: VersionNode[];
  maintainers: MaintainerNode[];
  dependsOn: DependsOnEdge[];
  resolvedTo: ResolvedToEdge[];
  maintains: MaintainsEdge[];
  advisories: AdvisoryRecord[];
  /** Packument per package name, kept for the lockfile generator. */
  packuments: Map<string, ReducedPackument>;
}

export async function crawlEcosystem(
  registry: RegistryClient,
  options: CrawlOptions,
): Promise<CrawlResult> {
  const { ecosystem } = options;
  const packuments = new Map<string, ReducedPackument>();
  const depthOf = new Map<string, number>();

  const seeds = seedsFor(ecosystem, options.seedCount);
  let frontier: string[] = [...seeds];
  for (const seed of seeds) depthOf.set(seed, 0);

  let fetched = 0;

  for (let depth = 0; depth <= options.maxDepth && frontier.length > 0; depth++) {
    const nextNames = new Set<string>();
    const wantFull = depth <= options.fullMetadataDepth;
    options.onDepthStart?.({ depth, frontier: frontier.length, full: wantFull });

    const results = await Promise.all(
      frontier.map(async (name) => {
        const packument =
          ecosystem === 'pypi'
            ? await registry.pypiProject(name)
            : await registry.npmPackument(name, wantFull);
        fetched += 1;
        options.onProgress?.({ fetched, queued: frontier.length, depth, name });
        return [name, packument] as const;
      }),
    );

    for (const [name, packument] of results) {
      if (!packument) continue;
      packuments.set(name, packument);
      if (depth === options.maxDepth) continue;
      for (const version of packument.versions.slice(0, options.resolveVersionsPerPackage)) {
        for (const dependency of Object.keys(version.dependencies)) {
          if (packuments.has(dependency) || depthOf.has(dependency)) continue;
          depthOf.set(dependency, depth + 1);
          nextNames.add(dependency);
        }
      }
    }

    frontier = [...nextNames];
  }

  return assemble(ecosystem, packuments, options);
}

function assemble(
  ecosystem: Ecosystem,
  packuments: Map<string, ReducedPackument>,
  options: CrawlOptions,
): CrawlResult {
  const packages: PackageNode[] = [];
  const versions: VersionNode[] = [];
  const maintainersByKey = new Map<string, MaintainerNode>();
  const dependsOn: DependsOnEdge[] = [];
  const resolvedTo: ResolvedToEdge[] = [];
  const maintains: MaintainsEdge[] = [];

  // Version list per package, newest first, for semver resolution.
  const availableVersions = new Map<string, string[]>();
  for (const [name, packument] of packuments) {
    availableVersions.set(
      name,
      packument.versions.map((version) => version.version),
    );
  }

  const dependentCount = new Map<string, number>();

  for (const [name, packument] of packuments) {
    const pkgKey = packageKey(ecosystem, name);

    for (const maintainer of packument.maintainers) {
      const key = `${ecosystem}:${maintainer.username}`;
      if (!maintainersByKey.has(key)) {
        maintainersByKey.set(key, {
          key,
          username: maintainer.username,
          email_hash: maintainer.emailHash,
          ecosystem,
        });
      }
      maintains.push({ maintainer_key: key, package_key: pkgKey });
    }

    packages.push({
      key: pkgKey,
      name,
      ecosystem,
      downloads: 0, // filled in later from the downloads API
      created_at: packument.createdAt,
      dependent_count: 0,
    });

    const resolvable = packument.versions.slice(0, options.resolveVersionsPerPackage);

    for (const version of packument.versions) {
      versions.push({
        key: versionKey(ecosystem, name, version.version),
        package_key: pkgKey,
        package_name: name,
        ecosystem,
        version_string: version.version,
        published_at: version.publishedAt,
        is_compromised: false,
        compromised_from: NOT_COMPROMISED,
        compromised_to: NOT_COMPROMISED,
        advisory_id: '',
      });
    }

    for (const version of resolvable) {
      const fromKey = versionKey(ecosystem, name, version.version);
      const declared: Array<[string, string, DependsOnEdge['kind']]> = [
        ...Object.entries(version.dependencies).map(
          ([dep, range]) => [dep, range, 'prod'] as [string, string, DependsOnEdge['kind']],
        ),
        ...Object.entries(version.peerDependencies).map(
          ([dep, range]) => [dep, range, 'peer'] as [string, string, DependsOnEdge['kind']],
        ),
        ...Object.entries(version.optionalDependencies).map(
          ([dep, range]) => [dep, range, 'optional'] as [string, string, DependsOnEdge['kind']],
        ),
      ];

      for (const [depName, range, kind] of declared) {
        if (!packuments.has(depName)) continue; // outside the crawl boundary
        const depPackageKey = packageKey(ecosystem, depName);
        dependsOn.push({
          from_version_key: fromKey,
          to_package_key: depPackageKey,
          range,
          kind,
        });

        const resolved = resolveRange(range, availableVersions.get(depName) ?? []);
        if (!resolved) continue;
        resolvedTo.push({
          from_version_key: fromKey,
          to_version_key: versionKey(ecosystem, depName, resolved),
        });
        dependentCount.set(depPackageKey, (dependentCount.get(depPackageKey) ?? 0) + 1);
      }
    }
  }

  for (const pkg of packages) {
    pkg.dependent_count = dependentCount.get(pkg.key) ?? 0;
  }

  return {
    packages,
    versions,
    maintainers: [...maintainersByKey.values()],
    dependsOn,
    resolvedTo,
    maintains,
    advisories: [],
    packuments,
  };
}

/**
 * Resolve a declared range to a concrete published version, the way a package
 * manager would: the highest published version that satisfies the range.
 */
export function resolveRange(range: string, available: string[]): string | null {
  if (available.length === 0) return null;
  const valid = available.filter((version) => semver.valid(version) !== null);
  if (valid.length === 0) return available[0] ?? null;

  // Ranges npm accepts that semver.maxSatisfying does not: tags, git urls, "*".
  if (!range || range === '*' || range === 'latest' || range === '') {
    return semver.maxSatisfying(valid, '*') ?? valid[0] ?? null;
  }
  if (!semver.validRange(range)) {
    return semver.maxSatisfying(valid, '*') ?? valid[0] ?? null;
  }
  return semver.maxSatisfying(valid, range) ?? null;
}

/** Attach real weekly download counts. */
export async function attachDownloads(
  registry: RegistryClient,
  ecosystem: Ecosystem,
  packages: PackageNode[],
): Promise<void> {
  if (ecosystem !== 'npm') return;
  const counts = await registry.npmDownloads(packages.map((pkg) => pkg.name));
  for (const pkg of packages) {
    pkg.downloads = counts.get(pkg.name) ?? 0;
  }
}

/**
 * Attach real OSV.dev advisories to the packages the org actually depends on,
 * and mark every affected version. This is what makes "which version introduced
 * the vulnerability" a question about real data rather than invented data.
 */
export async function attachAdvisories(
  registry: RegistryClient,
  ecosystem: Ecosystem,
  packageNames: string[],
  versions: VersionNode[],
): Promise<AdvisoryRecord[]> {
  const records: AdvisoryRecord[] = [];
  const versionsByPackage = new Map<string, VersionNode[]>();
  for (const version of versions) {
    const list = versionsByPackage.get(version.package_key) ?? [];
    list.push(version);
    versionsByPackage.set(version.package_key, list);
  }

  for (const name of packageNames) {
    const advisories = await registry.osvAdvisories(ecosystem, name);
    if (advisories.length === 0) continue;
    const pkgKey = packageKey(ecosystem, name);
    const candidates = versionsByPackage.get(pkgKey) ?? [];

    for (const advisory of advisories) {
      const affected: string[] = [];
      for (const candidate of candidates) {
        if (isAffected(candidate.version_string, advisory.ranges, advisory.affectedVersions)) {
          affected.push(candidate.key);
          if (!candidate.advisory_id) candidate.advisory_id = advisory.id;
        }
      }
      if (affected.length === 0) continue;
      records.push({
        id: advisory.id,
        package_key: pkgKey,
        summary: advisory.summary,
        published: advisory.published,
        severity: advisory.severity,
        ranges: advisory.ranges,
        affected_version_keys: affected,
      });
    }
  }

  return records;
}

/** Half-open [introduced, fixed) semantics, as OSV defines them. */
export function isAffected(
  version: string,
  ranges: Array<{ introduced: string; fixed: string | null }>,
  explicitVersions: string[],
): boolean {
  if (explicitVersions.includes(version)) return true;
  if (!semver.valid(version)) return false;
  for (const range of ranges) {
    const introduced = range.introduced === '0' ? '0.0.0' : range.introduced;
    if (!semver.valid(introduced)) continue;
    if (semver.lt(version, introduced)) continue;
    if (range.fixed && semver.valid(range.fixed) && semver.gte(version, range.fixed)) continue;
    return true;
  }
  return false;
}
