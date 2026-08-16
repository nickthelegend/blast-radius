/**
 * Remediation planning — turning "you are exposed" into "here is the fix".
 *
 * Detection is only half an incident. The actionable question is which single
 * dependency to change, and to what, so that the compromised version stops
 * being resolved at all.
 *
 * That is a graph question, and a nicely-shaped one. A repo is exposed through
 * some *direct* dependency D whose tree reaches the compromised version C. The
 * fix is a version of D that does not reach C. So: take every published version
 * of D's package as an indexed source, take C as the target, and ask the engine
 * which of them can reach it — one `algo.MSpaths` call for all candidates at
 * once. Whatever comes back with no path is a safe upgrade, and the lowest such
 * version above the current one is the minimal change.
 *
 * When *no* version of D avoids C, that is reported plainly rather than papered
 * over: the fix has to come from upstream, and saying so is more useful than
 * inventing an upgrade that does not exist.
 */
import semver from 'semver';

import type { GraphPath, HydraClient, QueryOptions } from '../hydra/client.js';
import type { BlastRadiusReport, ExposedRepo } from './blastRadius.js';
import { BLAST_REL_TYPES } from './blastRadius.js';
import type { VersionRef } from './lookup.js';

export type FixKind =
  | 'upgrade-direct' // bump the direct dependency to a version that drops the bad one
  | 'upgrade-self' // the compromised package IS the direct dependency
  | 'no-safe-version' // nothing published avoids it — upstream must fix
  | 'unknown-chain'; // exposure has no usable chain (depth beyond the budget)

export interface RepoFix {
  repoKey: string;
  repoName: string;
  depth: number;
  chainText: string;
  kind: FixKind;
  /** The dependency to change. */
  packageKey: string;
  packageName: string;
  currentVersion: string;
  /** The version to move to, when one exists. */
  targetVersion: string | null;
  /** Every published version that avoids the compromised release. */
  safeVersions: string[];
  /** True when the move crosses a major version and so may break the build. */
  isMajorBump: boolean;
  /** Whether the recommended move goes forwards or backwards.
   *  A rollback is a legitimate — often the fastest — response to a live
   *  compromise, but it must never be presented as an upgrade. */
  direction: 'upgrade' | 'rollback' | 'none';
  explanation: string;
}

export interface RemediationPlan {
  source: VersionRef;
  fixes: RepoFix[];
  /** Distinct dependency changes — the real size of the remediation. */
  distinctChanges: Array<{
    packageName: string;
    from: string[];
    to: string;
    repos: string[];
    direction: 'upgrade' | 'rollback' | 'none';
  }>;
  reposExposed: number;
  reposFixable: number;
  elapsedMs: number;
  candidatesTested: number;
  cypher: string;
}

export interface RemediationOptions {
  maxDepth: number;
  pathCount: number;
  resultLimit: number;
  consistency?: QueryOptions['consistency'];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Which of these candidate versions can still reach the compromised version.
 *
 * One `algo.MSpaths` call with every candidate as an indexed source and the
 * compromised version as the single target. Non-pairwise, because the sets are
 * unrelated lists (and because pairwise mode is defective in this build — see
 * `blastRadiusForRepos`).
 */
async function versionsThatStillReach(
  client: HydraClient,
  candidateKeys: string[],
  compromisedKey: string,
  options: RemediationOptions,
): Promise<{ reaching: Set<string>; cypher: string; elapsedMs: number }> {
  if (candidateKeys.length === 0) {
    return { reaching: new Set(), cypher: '', elapsedMs: 0 };
  }

  const escape = (value: string) => value.replace(/'/g, "\\'");
  const sources = candidateKeys.map((key) => `'${escape(key)}'`).join(', ');
  const relTypes = BLAST_REL_TYPES.filter((type) => type === 'RESOLVED_TO')
    .map((type) => `'${type}'`)
    .join(', ');

  const cypher =
    `CALL algo.MSpaths({sourceLabel: 'Version', sourceProperty: 'key', sourceValues: [${sources}], ` +
    `targetLabel: 'Version', targetProperty: 'key', targetValues: ['${escape(compromisedKey)}'], ` +
    `pairwise: false, relTypes: [${relTypes}], relDirection: 'outgoing', ` +
    `maxLen: ${options.maxDepth}, pathCount: ${options.pathCount}, ` +
    `resultLimit: ${options.resultLimit}}) YIELD path RETURN path`;

  const result = await client.query(cypher, { consistency: options.consistency });

  // A path's first node is the candidate it started from.
  const reaching = new Set<string>();
  for (const record of result.records) {
    const path = record.path as GraphPath | undefined;
    const first = path?.nodes[0];
    if (first) reaching.add(str(first.properties.key));
  }

  return { reaching, cypher, elapsedMs: result.elapsedMs };
}

/** Every published version of a package, as keys. */
async function versionsOfPackage(
  client: HydraClient,
  packageKey: string,
  options: RemediationOptions,
): Promise<Array<{ key: string; version: string }>> {
  const result = await client.query(
    'MATCH (v:Version) WHERE v.package_key = $package_key AND v.is_compromised = false ' +
      'RETURN v.key AS key, v.version_string AS version_string',
    { consistency: options.consistency, parameters: { package_key: packageKey } },
  );
  return result.records
    .map((record) => ({ key: str(record.key), version: str(record.version_string) }))
    .filter((entry) => entry.key !== '' && semver.valid(entry.version) !== null);
}

export async function planRemediation(
  client: HydraClient,
  report: BlastRadiusReport,
  options: RemediationOptions,
): Promise<RemediationPlan> {
  const startedAt = performance.now();
  const fixes: RepoFix[] = [];
  let candidatesTested = 0;
  let lastCypher = '';

  // Group exposures by the direct dependency that carries them, so one MSpaths
  // call covers every repo that shares the same offending dependency.
  const byDirectDependency = new Map<string, { versionKey: string; exposures: ExposedRepo[] }>();

  for (const exposure of report.exposedRepos) {
    // chain[0] is the repo; chain[1] is the direct dependency it pulled in.
    const direct = exposure.chain[1];
    if (!direct) {
      fixes.push(unknownChain(exposure));
      continue;
    }
    const entry = byDirectDependency.get(direct.key) ?? {
      versionKey: direct.key,
      exposures: [],
    };
    entry.exposures.push(exposure);
    byDirectDependency.set(direct.key, entry);
  }

  for (const [directVersionKey, group] of byDirectDependency) {
    const directVersion = await lookupVersion(client, directVersionKey, options);
    if (!directVersion) {
      for (const exposure of group.exposures) fixes.push(unknownChain(exposure));
      continue;
    }

    const isSelf = directVersion.packageKey === report.source.packageKey;
    const candidates = await versionsOfPackage(client, directVersion.packageKey, options);
    candidatesTested += candidates.length;

    let safe: string[];

    if (isSelf) {
      // The compromised package is itself the direct dependency: any other
      // published version of it is a fix, no traversal needed.
      safe = candidates
        .filter((candidate) => candidate.key !== report.source.key)
        .map((candidate) => candidate.version);
    } else {
      const { reaching, cypher } = await versionsThatStillReach(
        client,
        candidates.map((candidate) => candidate.key),
        report.source.key,
        options,
      );
      if (cypher) lastCypher = cypher;
      safe = candidates
        .filter((candidate) => !reaching.has(candidate.key))
        .map((candidate) => candidate.version);
    }

    safe.sort(semver.compare);
    const current = directVersion.versionString;

    // The minimal change: the lowest safe version at or above what is installed.
    // If nothing above it is safe, a downgrade to the highest safe version below
    // is still a real fix, so it is offered rather than reporting failure.
    const upgrades = safe.filter((version) => semver.gt(version, current));
    const downgrades = safe.filter((version) => semver.lt(version, current));
    const target = upgrades[0] ?? downgrades[downgrades.length - 1] ?? null;

    const direction: RepoFix['direction'] =
      target === null ? 'none' : semver.gt(target, current) ? 'upgrade' : 'rollback';

    for (const exposure of group.exposures) {
      const kind: FixKind = target === null ? 'no-safe-version' : isSelf ? 'upgrade-self' : 'upgrade-direct';
      fixes.push({
        repoKey: exposure.repoKey,
        repoName: exposure.repoName,
        depth: exposure.depth,
        chainText: exposure.chainText,
        kind,
        packageKey: directVersion.packageKey,
        packageName: directVersion.packageName,
        currentVersion: current,
        targetVersion: target,
        safeVersions: safe,
        isMajorBump: target !== null && semver.major(target) !== semver.major(current),
        direction,
        explanation: explain(
          kind,
          direction,
          directVersion.packageName,
          current,
          target,
          report.source.key,
        ),
      });
    }
  }

  // Collapse to the distinct set of dependency changes an engineer would make.
  const changes = new Map<
    string,
    {
      packageName: string;
      from: Set<string>;
      to: string;
      repos: Set<string>;
      direction: 'upgrade' | 'rollback' | 'none';
    }
  >();
  for (const fix of fixes) {
    if (!fix.targetVersion) continue;
    const key = `${fix.packageName}@${fix.targetVersion}`;
    const entry = changes.get(key) ?? {
      packageName: fix.packageName,
      from: new Set<string>(),
      to: fix.targetVersion,
      repos: new Set<string>(),
      direction: fix.direction,
    };
    entry.from.add(fix.currentVersion);
    entry.repos.add(fix.repoName);
    changes.set(key, entry);
  }

  fixes.sort((a, b) => a.repoName.localeCompare(b.repoName));

  return {
    source: report.source,
    fixes,
    distinctChanges: [...changes.values()].map((change) => ({
      packageName: change.packageName,
      from: [...change.from].sort(),
      to: change.to,
      repos: [...change.repos].sort(),
      direction: change.direction,
    })),
    reposExposed: report.exposedRepos.length,
    reposFixable: fixes.filter((fix) => fix.targetVersion !== null).length,
    elapsedMs: performance.now() - startedAt,
    candidatesTested,
    cypher: lastCypher,
  };
}

function unknownChain(exposure: ExposedRepo): RepoFix {
  return {
    repoKey: exposure.repoKey,
    repoName: exposure.repoName,
    depth: exposure.depth,
    chainText: exposure.chainText,
    kind: 'unknown-chain',
    packageKey: '',
    packageName: '',
    currentVersion: '',
    targetVersion: null,
    safeVersions: [],
    isMajorBump: false,
    direction: 'none',
    explanation:
      'no dependency chain was returned for this exposure, so the offending direct ' +
      'dependency could not be identified — raise --depth and re-run',
  };
}

function explain(
  kind: FixKind,
  direction: RepoFix['direction'],
  packageName: string,
  current: string,
  target: string | null,
  compromisedKey: string,
): string {
  const move = direction === 'rollback' ? 'roll back to' : 'upgrade to';
  switch (kind) {
    case 'upgrade-self':
      return `${packageName} is a direct dependency; ${move} ${target ?? 'a safe release'} from ${current}`;
    case 'upgrade-direct':
      return `${packageName} ${current} pulls in ${compromisedKey}; ${move} ${target ?? 'no release'}, which does not`;
    case 'no-safe-version':
      return (
        `no published version of ${packageName} avoids ${compromisedKey} — ` +
        `the fix has to come from upstream, or the dependency has to be dropped`
      );
    default:
      return 'chain unavailable';
  }
}

async function lookupVersion(
  client: HydraClient,
  key: string,
  options: RemediationOptions,
): Promise<{ packageKey: string; packageName: string; versionString: string } | null> {
  const result = await client.query(
    'MATCH (v:Version) WHERE v.key = $key ' +
      'RETURN v.package_key AS package_key, v.package_name AS package_name, ' +
      'v.version_string AS version_string LIMIT 1',
    { consistency: options.consistency, parameters: { key } },
  );
  const record = result.records[0];
  if (!record) return null;
  return {
    packageKey: str(record.package_key),
    packageName: str(record.package_name),
    versionString: str(record.version_string),
  };
}
