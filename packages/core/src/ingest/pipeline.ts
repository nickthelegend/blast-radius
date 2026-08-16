/**
 * Ingestion orchestration: registry -> GraphSnapshot on disk.
 *
 * The result is written to `data/snapshot/` and committed, so a clean clone can
 * `make demo` and get a populated, realistic graph with no network access. A
 * live refresh is `make ingest`.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { BlastConfig } from '../config.js';
import type { Ecosystem, GraphSnapshot, PackageNode } from '../model/types.js';
import { computeSimilarityEdges } from '../queries/typosquats.js';
import { attachAdvisories, attachDownloads, crawlEcosystem } from './build.js';
import { generateOrg, plantIncidentSnapshots } from './org.js';
import { RegistryClient } from './registry.js';
import { DEFAULT_SCENARIO } from './scenarios.js';

export const SNAPSHOT_FILE = 'graph.json';
export const ID_MAP_FILE = 'id-map.json';

export interface IngestOptions {
  config: BlastConfig;
  onLog?: (message: string) => void;
}

export async function runIngest(options: IngestOptions): Promise<GraphSnapshot> {
  const { config } = options;
  const log = options.onLog ?? (() => {});

  const registry = new RegistryClient({
    cacheDir: config.paths.cache,
    concurrency: config.ingest.concurrency,
    offline: config.ingest.offline,
    npmRegistryUrl: config.ingest.npmRegistryUrl,
    npmDownloadsApi: config.ingest.npmDownloadsApi,
    pypiRegistryUrl: config.ingest.pypiRegistryUrl,
    osvApiUrl: config.ingest.osvApiUrl,
    maxVersionsPerPackage: config.ingest.maxVersionsPerPackage,
  });

  const snapshot: GraphSnapshot = {
    generated_at: new Date().toISOString(),
    ecosystems: config.ingest.ecosystems as Ecosystem[],
    incident: null,
    packages: [],
    versions: [],
    maintainers: [],
    orgs: [],
    repos: [],
    snapshots: [],
    depends_on: [],
    resolved_to: [],
    maintains: [],
    resolved: [],
    has_snapshot: [],
    name_similar_to: [],
    advisories: [],
  };

  for (const ecosystem of config.ingest.ecosystems as Ecosystem[]) {
    log(`crawling ${ecosystem}: ${config.ingest.seedCount} seeds, depth ${config.ingest.maxDepth}`);
    let lastReport = 0;
    const crawl = await crawlEcosystem(registry, {
      ecosystem,
      seedCount: config.ingest.seedCount,
      maxDepth: config.ingest.maxDepth,
      fullMetadataDepth: config.ingest.fullMetadataDepth,
      resolveVersionsPerPackage: config.ingest.resolveVersionsPerPackage,
      onDepthStart: ({ depth, frontier, full }) => {
        log(
          `  depth ${depth}: ${frontier} packages to fetch ` +
            `(${full ? 'full packuments' : 'abbreviated'})`,
        );
      },
      onProgress: ({ fetched, depth }) => {
        if (fetched - lastReport >= 100) {
          lastReport = fetched;
          log(`    depth ${depth}: ${fetched} fetched`);
        }
      },
    });

    log(`  ${crawl.packages.length} packages, ${crawl.versions.length} versions`);
    log(`  ${crawl.resolvedTo.length} resolved dependency edges`);

    log('  fetching weekly download counts');
    await attachDownloads(registry, ecosystem, crawl.packages);

    // Advisories are fetched for the most-depended-on slice: OSV is one request
    // per package and the tail contributes little.
    const advisoryTargets = [...crawl.packages]
      .sort((a, b) => b.dependent_count - a.dependent_count)
      .slice(0, config.ingest.advisoryPackageCount)
      .map((pkg) => pkg.name);
    log(`  fetching OSV advisories for ${advisoryTargets.length} packages`);
    const advisories = await attachAdvisories(
      registry,
      ecosystem,
      advisoryTargets,
      crawl.versions,
    );
    log(`  ${advisories.length} advisories matched versions in the graph`);

    snapshot.packages.push(...crawl.packages);
    snapshot.versions.push(...crawl.versions);
    snapshot.maintainers.push(...crawl.maintainers);
    snapshot.depends_on.push(...crawl.dependsOn);
    snapshot.resolved_to.push(...crawl.resolvedTo);
    snapshot.maintains.push(...crawl.maintains);
    snapshot.advisories.push(...advisories);
  }

  // --- synthetic organization ---------------------------------------------
  const candidatePackageKeys = [...snapshot.packages]
    .sort((a, b) => b.dependent_count - a.dependent_count || b.downloads - a.downloads)
    .map((pkg) => pkg.key);

  const scenario = DEFAULT_SCENARIO;
  const now = config.org.simulatedNow;

  log(`generating org "${config.org.name}" with ${config.org.repoCount} repos`);
  let org = generateOrg(
    { versions: snapshot.versions, resolvedTo: snapshot.resolved_to, candidatePackageKeys },
    {
      orgName: config.org.name,
      repoCount: config.org.repoCount,
      snapshotsPerRepo: config.org.snapshotsPerRepo,
      seed: config.org.randomSeed,
      now,
      incidentFrom: scenario.from(now),
      incidentTo: scenario.to(now),
      directDepsMin: config.org.directDepsMin,
      directDepsMax: config.org.directDepsMax,
      maxLockfileEntries: config.org.maxLockfileEntries,
    },
  );

  // --- plant the incident so the Time Machine has in-window data ------------
  const seedVersion = chooseIncidentVersion(snapshot, org.directDependencyKeys);
  if (seedVersion) {
    const replacement = chooseReplacementVersion(snapshot, seedVersion.key) ?? seedVersion;

    const eligible = org.repos.map((repo) => repo.key);
    const assignments = eligible.slice(0, scenario.plantRepoCount).map((repoKey, index) => ({
      repoKey,
      fate:
        index % 3 === 0
          ? ('still-exposed' as const)
          : index % 3 === 1
            ? ('upgraded' as const)
            : ('never-in-window' as const),
    }));

    log(`planting incident lockfiles for ${assignments.length} repos on ${seedVersion.key}`);
    snapshot.incident = {
      scenario: scenario.name,
      version_key: seedVersion.key,
      package_key: seedVersion.package_key,
      replacement_version_key: replacement.key,
      from: scenario.from(now),
      to: scenario.to(now),
    };
    org = plantIncidentSnapshots(
      org,
      { versions: snapshot.versions, resolvedTo: snapshot.resolved_to, candidatePackageKeys },
      {
        from: scenario.from(now),
        to: scenario.to(now),
        compromisedVersionKey: seedVersion.key,
        replacementVersionKey: replacement.key,
        assignments,
        seed: config.org.randomSeed,
        maxLockfileEntries: config.org.maxLockfileEntries,
      },
    );
  }

  snapshot.orgs = org.orgs;
  snapshot.repos = org.repos;
  snapshot.snapshots = org.snapshots;
  snapshot.resolved = org.resolved;
  snapshot.has_snapshot = org.hasSnapshot;

  log(`  ${org.repos.length} repos, ${org.snapshots.length} lockfile snapshots`);
  log(`  ${org.resolved.length} RESOLVED edges`);

  // --- typosquat proximity -------------------------------------------------
  const packagesByKey = new Map(snapshot.packages.map((pkg) => [pkg.key, pkg]));
  const trusted: PackageNode[] = [...new Set(org.directDependencyKeys)]
    .map((key) => packagesByKey.get(key))
    .filter((pkg): pkg is PackageNode => pkg !== undefined)
    .sort((a, b) => b.dependent_count - a.dependent_count)
    .slice(0, config.typosquat.topN);

  // Pull real near-name packages off the registry. Without this the candidate
  // pool is only packages reachable from the dependency crawl — all of them
  // legitimate by construction — so the check would have nothing real to find.
  log(`searching the registry for names near ${trusted.length} trusted packages`);
  const known = new Set(snapshot.packages.map((pkg) => pkg.key));
  const candidates: PackageNode[] = [...snapshot.packages];
  const discovered: PackageNode[] = [];

  for (const pkg of trusted) {
    const results = await registry.npmSearch(pkg.name, config.typosquat.searchSize);
    for (const result of results) {
      const key = `npm:${result.name}`;
      if (known.has(key)) continue;
      known.add(key);
      const node: PackageNode = {
        key,
        name: result.name,
        ecosystem: 'npm',
        downloads: 0,
        created_at: result.date,
        dependent_count: 0,
      };
      discovered.push(node);
      candidates.push(node);
    }
  }

  log(`  ${discovered.length} candidate packages discovered`);

  // Similarity depends only on names, so the edges are computed *before* any
  // download counts are fetched. The npm downloads endpoint rejects scoped
  // packages in bulk and has to be called one name at a time for them, so
  // fetching counts for every search result costs minutes; fetching them for
  // just the handful that produced an edge costs seconds.
  log(`computing NAME_SIMILAR_TO edges for ${trusted.length} trusted packages`);
  snapshot.name_similar_to = computeSimilarityEdges(trusted, candidates, {
    maxDistance: config.typosquat.maxDistance,
    minNameLength: config.typosquat.minNameLength,
  });

  const referenced = new Set(snapshot.name_similar_to.map((edge) => edge.to_package_key));
  const kept = discovered.filter((pkg) => referenced.has(pkg.key));
  if (kept.length > 0) {
    log(`  fetching download counts for ${kept.length} near-name candidates`);
    await attachDownloads(registry, 'npm', kept);
  }
  snapshot.packages.push(...kept);
  log(`  ${snapshot.name_similar_to.length} similarity edges, ${kept.length} new packages kept`);

  writeSnapshot(config.paths.snapshot, snapshot);
  log(`wrote ${join(config.paths.snapshot, SNAPSHOT_FILE)}`);
  return snapshot;
}

/**
 * Pick the version the demo incident centres on.
 *
 * It has to be the version other packages actually *resolve to*, not simply a
 * recent one. A version with no incoming `RESOLVED_TO` edges is depended on by
 * nothing, so its blast radius is empty by construction and every exposure
 * would have to be manufactured as a direct dependency — which is exactly the
 * degenerate, depth-1-everywhere result that makes the whole traversal look
 * pointless. So candidates are ranked by how many versions resolve to them.
 */
function chooseIncidentVersion(snapshot: GraphSnapshot, directKeys: string[]) {
  const versionsByPackage = new Map<string, typeof snapshot.versions>();
  for (const version of snapshot.versions) {
    const list = versionsByPackage.get(version.package_key) ?? [];
    list.push(version);
    versionsByPackage.set(version.package_key, list);
  }

  const incoming = new Map<string, number>();
  for (const edge of snapshot.resolved_to) {
    incoming.set(edge.to_version_key, (incoming.get(edge.to_version_key) ?? 0) + 1);
  }

  const preferred = DEFAULT_SCENARIO.preferredPackages;
  const ordered = [...new Set([...preferred, ...directKeys])];

  for (const packageKey of ordered) {
    const list = versionsByPackage.get(packageKey);
    if (!list || list.length < 2) continue;
    const ranked = [...list].sort(
      (a, b) => (incoming.get(b.key) ?? 0) - (incoming.get(a.key) ?? 0) || b.published_at - a.published_at,
    );
    const compromised = ranked[0];
    if (!compromised || (incoming.get(compromised.key) ?? 0) === 0) continue;
    return compromised;
  }
  return null;
}

/**
 * The version repos move to once the compromise is known.
 *
 * Real remediation is usually a rollback: the malicious build is normally the
 * newest publish, so there is nothing newer to upgrade into and teams pin the
 * previous known-good release instead.
 */
function chooseReplacementVersion(snapshot: GraphSnapshot, compromisedKey: string) {
  const compromised = snapshot.versions.find((version) => version.key === compromisedKey);
  if (!compromised) return null;
  const siblings = snapshot.versions
    .filter(
      (version) =>
        version.package_key === compromised.package_key && version.key !== compromised.key,
    )
    .sort((a, b) => b.published_at - a.published_at);

  const newer = siblings.filter((version) => version.published_at > compromised.published_at);
  return newer[newer.length - 1] ?? siblings[0] ?? null;
}

export function writeSnapshot(dir: string, snapshot: GraphSnapshot): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(snapshot));
}

export function readSnapshot(dir: string): GraphSnapshot {
  const path = join(dir, SNAPSHOT_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `no graph snapshot at ${path}.\n` +
        `Run \`make ingest\` to build one from the live npm registry, or \`make demo\` ` +
        `to load the committed one.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as GraphSnapshot;
}

export function snapshotExists(dir: string): boolean {
  return existsSync(join(dir, SNAPSHOT_FILE));
}
