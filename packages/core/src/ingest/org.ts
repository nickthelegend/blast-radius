/**
 * The synthetic organization layered on top of the real package graph.
 *
 * Only this part is generated — every package, version, dependency edge and
 * maintainer underneath it comes from the real npm registry. What is invented
 * is a plausible company: repositories, the packages they depend on, and a
 * history of lockfile captures over a simulated timeline.
 *
 * The lockfile history is the point. A `LockfileSnapshot` is what a repo's
 * resolved dependency tree looked like at one instant, so a run of them is a
 * record of what each repo shipped over time. That is what makes
 * "who resolved the bad version while it was live" answerable at all.
 *
 * Generation is fully deterministic given `ORG_RANDOM_SEED`, so `make demo`
 * produces an identical graph on every clone and the documented example output
 * stays true.
 */
import type {
  HasSnapshotEdge,
  LockfileSnapshotNode,
  LockfileSource,
  OrgNode,
  RepoNode,
  ResolvedEdge,
  ResolvedToEdge,
  VersionNode,
} from '../model/types.js';
import { repoKey as makeRepoKey, snapshotKey as makeSnapshotKey } from '../model/types.js';

/** Deterministic PRNG (mulberry32) — small, fast, and reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPO_NAMES = [
  ['payments-service', 'typescript', 'package-lock.json'],
  ['onboarding-frontend', 'typescript', 'pnpm-lock.yaml'],
  ['billing-api', 'typescript', 'package-lock.json'],
  ['internal-cli-tool', 'javascript', 'package-lock.json'],
  ['notifications-worker', 'typescript', 'yarn.lock'],
  ['auth-gateway', 'typescript', 'package-lock.json'],
  ['admin-dashboard', 'typescript', 'pnpm-lock.yaml'],
  ['search-indexer', 'javascript', 'package-lock.json'],
  ['reporting-service', 'typescript', 'yarn.lock'],
  ['webhooks-relay', 'javascript', 'package-lock.json'],
  ['customer-portal', 'typescript', 'pnpm-lock.yaml'],
  ['data-pipeline', 'typescript', 'package-lock.json'],
  ['fraud-detection', 'typescript', 'yarn.lock'],
  ['mobile-bff', 'typescript', 'package-lock.json'],
  ['inventory-sync', 'javascript', 'package-lock.json'],
  ['design-system', 'typescript', 'pnpm-lock.yaml'],
  ['docs-site', 'typescript', 'package-lock.json'],
  ['ops-runbook-bot', 'javascript', 'yarn.lock'],
  ['pricing-engine', 'typescript', 'package-lock.json'],
  ['audit-log-service', 'typescript', 'yarn.lock'],
] as const;

export interface OrgGenerationOptions {
  orgName: string;
  repoCount: number;
  snapshotsPerRepo: number;
  seed: number;
  /** Simulated "now". Snapshots are spread over the months before it. */
  now: number;
  /** The incident window the demo scenario centres on. Snapshots are
   *  deliberately placed inside it, because a six-minute window would
   *  otherwise almost never contain a CI lockfile capture. */
  incidentFrom: number;
  incidentTo: number;
  /** Direct dependencies per repo. */
  directDepsMin: number;
  directDepsMax: number;
  /** Cap on resolved entries recorded per lockfile snapshot. */
  maxLockfileEntries: number;
}

export interface OrgGenerationResult {
  orgs: OrgNode[];
  repos: RepoNode[];
  snapshots: LockfileSnapshotNode[];
  resolved: ResolvedEdge[];
  hasSnapshot: HasSnapshotEdge[];
  /** Package keys the org depends on directly, for the typosquat trusted set. */
  directDependencyKeys: string[];
}

export interface OrgGenerationInput {
  versions: VersionNode[];
  resolvedTo: ResolvedToEdge[];
  /** Candidate packages for direct dependencies, most-depended-on first. */
  candidatePackageKeys: string[];
}

export function generateOrg(
  input: OrgGenerationInput,
  options: OrgGenerationOptions,
): OrgGenerationResult {
  const random = mulberry32(options.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const pickInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

  // --- indexes ------------------------------------------------------------
  const versionsByPackage = new Map<string, VersionNode[]>();
  for (const version of input.versions) {
    const list = versionsByPackage.get(version.package_key) ?? [];
    list.push(version);
    versionsByPackage.set(version.package_key, list);
  }
  for (const list of versionsByPackage.values()) {
    list.sort((a, b) => a.published_at - b.published_at);
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of input.resolvedTo) {
    const list = adjacency.get(edge.from_version_key) ?? [];
    list.push(edge.to_version_key);
    adjacency.set(edge.from_version_key, list);
  }

  /** The version a package manager would have picked at instant `t`: the
   *  newest one published at or before it. */
  const versionAt = (packageKey: string, t: number): VersionNode | null => {
    const list = versionsByPackage.get(packageKey);
    if (!list || list.length === 0) return null;
    let chosen: VersionNode | null = null;
    for (const version of list) {
      if (version.published_at > 0 && version.published_at <= t) chosen = version;
    }
    return chosen ?? list[0]!;
  };

  /** Breadth-first transitive closure — a lockfile's full resolved tree. */
  const closure = (roots: string[], limit: number): string[] => {
    const seen = new Set<string>(roots);
    const queue = [...roots];
    const out: string[] = [];
    while (queue.length > 0 && out.length < limit) {
      const current = queue.shift()!;
      out.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return out;
  };

  // --- org and repos ------------------------------------------------------
  const org: OrgNode = { key: options.orgName, name: options.orgName };
  const repoCount = Math.min(options.repoCount, REPO_NAMES.length);
  const repos: RepoNode[] = [];
  const snapshots: LockfileSnapshotNode[] = [];
  const resolved: ResolvedEdge[] = [];
  const hasSnapshot: HasSnapshotEdge[] = [];
  const directDependencyKeys = new Set<string>();

  // Weight selection towards the most-depended-on packages, which is how real
  // dependency sets actually look.
  const candidates = input.candidatePackageKeys.filter((key) => versionsByPackage.has(key));
  const weightedPick = (): string => {
    const bias = Math.floor(Math.pow(random(), 2) * candidates.length);
    return candidates[Math.min(bias, candidates.length - 1)]!;
  };

  const day = 86_400_000;

  for (let index = 0; index < repoCount; index++) {
    const [name, language, lockfileSource] = REPO_NAMES[index]!;
    const key = makeRepoKey(org.key, name);
    repos.push({
      key,
      org_key: org.key,
      name,
      language,
      lockfile_source: lockfileSource as LockfileSource,
    });

    const directCount = pickInt(options.directDepsMin, options.directDepsMax);
    const directs = new Set<string>();
    for (let i = 0; i < directCount; i++) directs.add(weightedPick());
    for (const direct of directs) directDependencyKeys.add(direct);

    // Snapshot timeline: evenly spread over the last ~6 months, jittered, with
    // the most recent capture near "now".
    const timeline: number[] = [];
    const span = 180 * day;
    for (let i = 0; i < options.snapshotsPerRepo; i++) {
      const fraction = i / Math.max(1, options.snapshotsPerRepo - 1);
      const jitter = (random() - 0.5) * 12 * day;
      timeline.push(Math.round(options.now - span * (1 - fraction) + jitter));
    }
    timeline.sort((a, b) => a - b);
    // Never let jitter push a capture into the future.
    for (let i = 0; i < timeline.length; i++) {
      timeline[i] = Math.min(timeline[i]!, options.now - 60_000);
    }

    for (let i = 0; i < timeline.length; i++) {
      const capturedAt = timeline[i]!;
      const isLast = i === timeline.length - 1;
      const supersededAt = isLast ? 0 : timeline[i + 1]!;

      const roots: string[] = [];
      for (const packageKey of directs) {
        const version = versionAt(packageKey, capturedAt);
        if (version) roots.push(version.key);
      }
      const entries = closure(roots, options.maxLockfileEntries);
      const rootSet = new Set(roots);

      const snapshotKey = makeSnapshotKey(key, capturedAt);
      snapshots.push({
        key: snapshotKey,
        repo_key: key,
        repo_name: name,
        captured_at: capturedAt,
        superseded_at: supersededAt,
        is_current: isLast,
        source: lockfileSource as LockfileSource,
        commit_sha: commitSha(random),
      });
      hasSnapshot.push({ repo_key: key, snapshot_key: snapshotKey });

      for (const versionKey of entries) {
        resolved.push({
          snapshot_key: snapshotKey,
          version_key: versionKey,
          direct: rootSet.has(versionKey),
        });
      }
    }
  }

  return {
    orgs: [org],
    repos,
    snapshots,
    resolved,
    hasSnapshot,
    directDependencyKeys: [...directDependencyKeys],
  };
}

function commitSha(random: () => number): string {
  const alphabet = '0123456789abcdef';
  let sha = '';
  for (let i = 0; i < 40; i++) sha += alphabet[Math.floor(random() * 16)];
  return sha;
}

/**
 * Plant lockfile captures inside a compromise window.
 *
 * Called after the base timeline exists and after a specific version has been
 * chosen as the compromised one. It gives a subset of repos a capture that
 * lands inside `[from, to]` and resolves the bad version, so the Time Machine
 * has genuine in-window data to find. Each planted repo is assigned one of
 * three fates, which is what makes the "exposed now" vs "exposed during the
 * window" distinction visible rather than theoretical:
 *
 *   - `still-exposed`   the in-window capture is still the current lockfile
 *   - `upgraded`        a later capture replaced it and dropped the bad version
 *   - `never-in-window` pinned the bad version, but only outside the window
 */
export interface PlantOptions {
  from: number;
  to: number;
  compromisedVersionKey: string;
  /** Repo keys to plant into, with the fate each should end up with. */
  assignments: Array<{
    repoKey: string;
    fate: 'still-exposed' | 'upgraded' | 'never-in-window';
  }>;
  /** Version the `upgraded` repos move to. */
  replacementVersionKey: string;
  seed: number;
  maxLockfileEntries: number;
}

export function plantIncidentSnapshots(
  base: OrgGenerationResult,
  input: OrgGenerationInput,
  options: PlantOptions,
): OrgGenerationResult {
  const random = mulberry32(options.seed ^ 0x5eed);
  const adjacency = new Map<string, string[]>();
  for (const edge of input.resolvedTo) {
    const list = adjacency.get(edge.from_version_key) ?? [];
    list.push(edge.to_version_key);
    adjacency.set(edge.from_version_key, list);
  }

  const closure = (roots: string[], limit: number): string[] => {
    const seen = new Set<string>(roots);
    const queue = [...roots];
    const out: string[] = [];
    while (queue.length > 0 && out.length < limit) {
      const current = queue.shift()!;
      out.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return out;
  };

  // Reverse adjacency: which versions resolve TO a given version. Used to give
  // the compromised package a realistic route into a repo — arriving through a
  // dependency the repo actually asked for, rather than being bolted on as a
  // direct dependency of everything.
  const dependents = new Map<string, string[]>();
  for (const edge of input.resolvedTo) {
    const list = dependents.get(edge.to_version_key) ?? [];
    list.push(edge.from_version_key);
    dependents.set(edge.to_version_key, list);
  }

  const repos = new Map(base.repos.map((repo) => [repo.key, repo]));
  const snapshots = [...base.snapshots];
  const resolved = [...base.resolved];
  const hasSnapshot = [...base.hasSnapshot];

  /** The direct dependencies a repo already had, from its newest snapshot. */
  const priorDirects = new Map<string, string[]>();
  for (const snapshot of base.snapshots) {
    const existing = priorDirects.get(snapshot.repo_key);
    const newest = base.snapshots
      .filter((entry) => entry.repo_key === snapshot.repo_key)
      .sort((a, b) => b.captured_at - a.captured_at)[0];
    if (existing || !newest) continue;
    priorDirects.set(
      snapshot.repo_key,
      base.resolved
        .filter((edge) => edge.snapshot_key === newest.key && edge.direct)
        .map((edge) => edge.version_key),
    );
  }

  const windowSpan = Math.max(1, options.to - options.from);

  for (const assignment of options.assignments) {
    const repo = repos.get(assignment.repoKey);
    if (!repo) continue;

    // Existing captures for this repo become history: the planted one is newer.
    const existing = snapshots
      .filter((snapshot) => snapshot.repo_key === repo.key)
      .sort((a, b) => a.captured_at - b.captured_at);

    const capturedAt =
      assignment.fate === 'never-in-window'
        ? options.from - Math.round(random() * 20 * 86_400_000) - 86_400_000
        : options.from + Math.round(random() * windowSpan * 0.85) + 1;

    // Anything captured at or after the planted snapshot would contradict it.
    for (const snapshot of existing) {
      if (snapshot.captured_at >= capturedAt) {
        snapshot.captured_at = capturedAt - Math.round(random() * 5 * 86_400_000) - 3_600_000;
      }
    }

    // Keep the repo's real dependency set and route the compromised package in
    // through it where possible: a dependent of the bad version that the repo
    // can plausibly depend on directly. That produces a genuine chain
    // (repo -> some-tool -> bad-package) instead of pinning the malicious
    // version as a direct dependency of every planted repo, which would make
    // every exposure look like depth 1 and hide the transitive case entirely.
    const existingDirects = priorDirects.get(repo.key) ?? [];
    const roots = [...existingDirects];
    let reaches = closure(roots, options.maxLockfileEntries).includes(
      options.compromisedVersionKey,
    );

    if (!reaches) {
      const carriers = dependents.get(options.compromisedVersionKey) ?? [];
      const carrier = carriers[Math.floor(random() * carriers.length)];
      if (carrier) {
        roots.push(carrier);
        reaches = true;
      } else {
        // Nothing depends on it in this graph, so the only honest way a repo
        // resolves it is as a direct dependency.
        roots.push(options.compromisedVersionKey);
      }
    }

    const entries = closure(roots, options.maxLockfileEntries);
    if (!entries.includes(options.compromisedVersionKey)) {
      entries.push(options.compromisedVersionKey);
    }
    const rootSet = new Set(roots);
    const key = makeSnapshotKey(repo.key, capturedAt);

    snapshots.push({
      key,
      repo_key: repo.key,
      repo_name: repo.name,
      captured_at: capturedAt,
      superseded_at: 0,
      is_current: true,
      source: repo.lockfile_source,
      commit_sha: commitSha(random),
    });
    hasSnapshot.push({ repo_key: repo.key, snapshot_key: key });
    for (const versionKey of entries) {
      resolved.push({
        snapshot_key: key,
        version_key: versionKey,
        direct: rootSet.has(versionKey),
      });
    }

    if (assignment.fate === 'upgraded' || assignment.fate === 'never-in-window') {
      // A remediation capture lands after the window, pinning the safe version.
      const remediatedAt = options.to + Math.round(random() * 3_600_000) + 900_000;
      const remediatedKey = makeSnapshotKey(repo.key, remediatedAt);
      const safeRoots = [...existingDirects, options.replacementVersionKey];
      snapshots.push({
        key: remediatedKey,
        repo_key: repo.key,
        repo_name: repo.name,
        captured_at: remediatedAt,
        superseded_at: 0,
        is_current: true,
        source: repo.lockfile_source,
        commit_sha: commitSha(random),
      });
      hasSnapshot.push({ repo_key: repo.key, snapshot_key: remediatedKey });
      const safeRootSet = new Set(safeRoots);
      for (const versionKey of closure(safeRoots, options.maxLockfileEntries)) {
        // Remediation means the bad version is gone. It can still appear in the
        // closure (something in the tree resolves to it), so it is excluded
        // explicitly — otherwise the "upgraded" repos would still look exposed
        // and the whole now-vs-then distinction would collapse.
        if (versionKey === options.compromisedVersionKey) continue;
        resolved.push({
          snapshot_key: remediatedKey,
          version_key: versionKey,
          direct: safeRootSet.has(versionKey),
        });
      }
    }
  }

  // Re-derive is_current / superseded_at per repo so the timeline stays
  // internally consistent after planting.
  const byRepo = new Map<string, LockfileSnapshotNode[]>();
  for (const snapshot of snapshots) {
    const list = byRepo.get(snapshot.repo_key) ?? [];
    list.push(snapshot);
    byRepo.set(snapshot.repo_key, list);
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => a.captured_at - b.captured_at);
    for (let i = 0; i < list.length; i++) {
      const snapshot = list[i]!;
      const next = list[i + 1];
      snapshot.is_current = next === undefined;
      snapshot.superseded_at = next ? next.captured_at : 0;
    }
  }

  return {
    orgs: base.orgs,
    repos: base.repos,
    snapshots,
    resolved,
    hasSnapshot,
    directDependencyKeys: base.directDependencyKeys,
  };
}
