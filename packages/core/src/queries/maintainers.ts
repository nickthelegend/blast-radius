/**
 * Maintainer Web — proactive, pre-compromise risk.
 *
 * "Which other packages share maintainers or infrastructure with this one?"
 * A compromised maintainer account is a compromised *set* of packages, so the
 * blast radius of an account is the union of everything it can publish. This
 * lets a team see that exposure before anything is actually compromised.
 *
 * Graph-native, in one call: `algo.SSpaths` from the package over `MAINTAINS`
 * edges with `relDirection: 'both'` and `maxLen: 2` walks
 *
 *     Package <-[:MAINTAINS]- Maintainer -[:MAINTAINS]-> Package
 *
 * so every 2-hop path is a sibling package and the middle node names the
 * maintainer they share. The reason for the risk comes back with the risk.
 */
import type { GraphPath, HydraClient, QueryOptions } from '../hydra/client.js';
import type { PackageRef } from './lookup.js';

export interface SharedMaintainerPackage {
  packageKey: string;
  packageName: string;
  sharedMaintainers: string[];
  downloads: number;
  /** True when the org's own dependency set includes this package — a shared
   *  maintainer matters far more when you already ship their other code. */
  isOrgDependency: boolean;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface MaintainerWebReport {
  package: PackageRef;
  maintainers: Array<{ key: string; username: string; packageCount: number }>;
  neighbors: SharedMaintainerPackage[];
  /** Neighbours the org actually depends on — the actionable subset. */
  orgExposedNeighbors: SharedMaintainerPackage[];
  riskLevel: RiskLevel;
  riskReason: string;
  elapsedMs: number;
  cypher: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Package keys the org currently depends on, from its live lockfiles. */
export async function orgDependencyKeys(
  client: HydraClient,
  options?: QueryOptions,
): Promise<Set<string>> {
  const result = await client.query(
    'MATCH (s:LockfileSnapshot)-[r:RESOLVED]->(v:Version) WHERE s.is_current = true ' +
      'RETURN DISTINCT v.package_key AS package_key',
    options,
  );
  return new Set(result.records.map((record) => str(record.package_key)).filter(Boolean));
}

export async function maintainerWeb(
  client: HydraClient,
  pkg: PackageRef,
  options: { pathCount: number; resultLimit: number; consistency?: QueryOptions['consistency'] },
): Promise<MaintainerWebReport> {
  const cypher =
    `CALL algo.SSpaths({sourceNode: ${pkg.id}, relTypes: ['MAINTAINS'], relDirection: 'both', ` +
    `maxLen: 2, pathCount: ${options.pathCount}, resultLimit: ${options.resultLimit}}) ` +
    `YIELD path RETURN path`;

  const [result, orgDeps] = await Promise.all([
    client.query(cypher, { consistency: options.consistency }),
    orgDependencyKeys(client, { consistency: options.consistency }),
  ]);

  const maintainerCounts = new Map<string, { key: string; username: string; packages: Set<string> }>();
  const neighbors = new Map<string, SharedMaintainerPackage>();

  for (const record of result.records) {
    const path = record.path as GraphPath | undefined;
    if (!path || !Array.isArray(path.nodes)) continue;

    const last = path.nodes[path.nodes.length - 1];
    if (!last) continue;

    if (last.labels.includes('Maintainer') && path.nodes.length === 2) {
      const key = str(last.properties.key);
      if (!maintainerCounts.has(key)) {
        maintainerCounts.set(key, {
          key,
          username: str(last.properties.username),
          packages: new Set(),
        });
      }
      continue;
    }

    if (!last.labels.includes('Package') || path.nodes.length !== 3) continue;
    const neighborKey = str(last.properties.key);
    if (neighborKey === pkg.key) continue;

    const middle = path.nodes[1];
    const maintainerKey = middle ? str(middle.properties.key) : '';
    const maintainerName = middle ? str(middle.properties.username) : '';
    if (maintainerKey) {
      const entry = maintainerCounts.get(maintainerKey) ?? {
        key: maintainerKey,
        username: maintainerName,
        packages: new Set<string>(),
      };
      entry.packages.add(neighborKey);
      maintainerCounts.set(maintainerKey, entry);
    }

    const existing = neighbors.get(neighborKey);
    if (existing) {
      if (maintainerName && !existing.sharedMaintainers.includes(maintainerName)) {
        existing.sharedMaintainers.push(maintainerName);
      }
    } else {
      neighbors.set(neighborKey, {
        packageKey: neighborKey,
        packageName: str(last.properties.name),
        sharedMaintainers: maintainerName ? [maintainerName] : [],
        downloads: numberOf(last.properties.downloads),
        isOrgDependency: orgDeps.has(neighborKey),
      });
    }
  }

  const allNeighbors = [...neighbors.values()].sort(
    (a, b) =>
      Number(b.isOrgDependency) - Number(a.isOrgDependency) ||
      b.sharedMaintainers.length - a.sharedMaintainers.length ||
      b.downloads - a.downloads,
  );
  const orgExposed = allNeighbors.filter((neighbor) => neighbor.isOrgDependency);

  // Risk is driven by how many of *your* dependencies one account can publish
  // to. Two of your packages behind one maintainer is a meaningfully different
  // situation from two hundred packages you have never installed.
  let riskLevel: RiskLevel = 'LOW';
  if (orgExposed.length >= 5) riskLevel = 'HIGH';
  else if (orgExposed.length >= 2) riskLevel = 'MEDIUM';

  const riskReason =
    orgExposed.length === 0
      ? `no other package sharing a maintainer with ${pkg.name} is in your dependency set`
      : `${orgExposed.length} of your dependencies share a maintainer with ${pkg.name}`;

  return {
    package: pkg,
    maintainers: [...maintainerCounts.values()]
      .map((entry) => ({
        key: entry.key,
        username: entry.username,
        packageCount: entry.packages.size,
      }))
      .sort((a, b) => b.packageCount - a.packageCount),
    neighbors: allNeighbors,
    orgExposedNeighbors: orgExposed,
    riskLevel,
    riskReason,
    elapsedMs: result.elapsedMs,
    cypher,
  };
}
