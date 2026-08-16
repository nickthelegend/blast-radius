/**
 * Bulk loader: GraphSnapshot -> HydraDB, entirely through batched `UNWIND`
 * writes.
 *
 * The batch forms HydraDB accepts are narrow, and worth stating exactly because
 * everything here is shaped by them:
 *
 *   vertices  UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Label, n.p = row.p
 *   edges     UNWIND $rows AS row
 *               MATCH (s:L {id: row.source_vertex}), (d:L {id: row.destination_vertex})
 *               MERGE (s)-[r:TYPE {id: row.relationship_vertex}]->(d) SET r.p = row.p
 *
 * Folding extra properties into the MERGE pattern is rejected — the pattern is
 * the identity being matched on — hence the MERGE-then-SET split. Relationship
 * MERGE *requires* an explicit `id: row.<field>`, so edges get ids from the
 * same registry as nodes, which keeps both idempotent across re-runs.
 */
import type { HydraClient } from './client.js';
import type { IdRegistry } from '../model/ids.js';
import type { GraphSnapshot } from '../model/types.js';

export interface LoadStats {
  label: string;
  count: number;
  requests: number;
  elapsedMs: number;
}

export interface LoadOptions {
  chunkSize?: number;
  onStage?: (stage: string, done: number, total: number) => void;
  /** Called when duplicate relationship ids are dropped from a batch. */
  onDuplicate?: (stage: string, dropped: number) => void;
}

const vertexStatement = (label: string, properties: string[]): string =>
  `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:${label}` +
  (properties.length ? `, ${properties.map((p) => `n.${p} = row.${p}`).join(', ')}` : '');

const edgeStatement = (
  sourceLabel: string,
  targetLabel: string,
  type: string,
  properties: string[],
): string =>
  `UNWIND $rows AS row ` +
  `MATCH (s:${sourceLabel} {id: row.source_vertex}), (d:${targetLabel} {id: row.destination_vertex}) ` +
  `MERGE (s)-[r:${type} {id: row.relationship_vertex}]->(d)` +
  (properties.length ? ` SET ${properties.map((p) => `r.${p} = row.${p}`).join(', ')}` : '');

export async function loadSnapshot(
  client: HydraClient,
  snapshot: GraphSnapshot,
  ids: IdRegistry,
  options: LoadOptions = {},
): Promise<LoadStats[]> {
  const chunkSize = options.chunkSize ?? 500;
  const stats: LoadStats[] = [];

  /**
   * Drop rows that reuse a relationship id.
   *
   * HydraDB rejects a whole batch with "idempotency key conflict for
   * relationship-import request key <id>: the batch carries this relationship
   * id twice with different endpoints or properties". Real registry metadata
   * produces these easily — a manifest can list the same package under both
   * `dependencies` and `peerDependencies`, so the pair (version, package) is
   * not unique on its own. Relationship ids below include the discriminator
   * that makes them unique; this is the belt-and-braces guard, and it reports
   * what it dropped rather than silently swallowing it.
   */
  const dedupe = (label: string, rows: Record<string, unknown>[]): Record<string, unknown>[] => {
    const seen = new Set<unknown>();
    const out: Record<string, unknown>[] = [];
    let dropped = 0;
    for (const row of rows) {
      const id = row.relationship_vertex;
      if (id === undefined) {
        out.push(row);
        continue;
      }
      if (seen.has(id)) {
        dropped += 1;
        continue;
      }
      seen.add(id);
      out.push(row);
    }
    if (dropped > 0) options.onDuplicate?.(label, dropped);
    return out;
  };

  const run = async (label: string, statement: string, input: Record<string, unknown>[]) => {
    const rows = dedupe(label, input);
    if (rows.length === 0) {
      stats.push({ label, count: 0, requests: 0, elapsedMs: 0 });
      return;
    }
    const result = await client.batch(statement, rows, {
      chunkSize,
      onProgress: (done, total) => options.onStage?.(label, done, total),
    });
    stats.push({ label, count: result.written, requests: result.requests, elapsedMs: result.elapsedMs });
  };

  // --- nodes ---------------------------------------------------------------

  await run(
    'Package',
    vertexStatement('Package', ['key', 'name', 'ecosystem', 'downloads', 'created_at', 'dependent_count']),
    snapshot.packages.map((pkg) => ({
      vertex: ids.packageId(pkg.key),
      key: pkg.key,
      name: pkg.name,
      ecosystem: pkg.ecosystem,
      downloads: pkg.downloads,
      created_at: pkg.created_at,
      dependent_count: pkg.dependent_count,
    })),
  );

  await run(
    'Version',
    vertexStatement('Version', [
      'key',
      'package_key',
      'package_name',
      'ecosystem',
      'version_string',
      'published_at',
      'is_compromised',
      'compromised_from',
      'compromised_to',
      'advisory_id',
    ]),
    snapshot.versions.map((version) => ({
      vertex: ids.versionId(version.key),
      key: version.key,
      package_key: version.package_key,
      package_name: version.package_name,
      ecosystem: version.ecosystem,
      version_string: version.version_string,
      published_at: version.published_at,
      is_compromised: version.is_compromised,
      compromised_from: version.compromised_from,
      compromised_to: version.compromised_to,
      advisory_id: version.advisory_id,
    })),
  );

  await run(
    'Maintainer',
    vertexStatement('Maintainer', ['key', 'username', 'email_hash', 'ecosystem']),
    snapshot.maintainers.map((maintainer) => ({
      vertex: ids.maintainerId(maintainer.key),
      key: maintainer.key,
      username: maintainer.username,
      email_hash: maintainer.email_hash,
      ecosystem: maintainer.ecosystem,
    })),
  );

  await run(
    'Org',
    vertexStatement('Org', ['key', 'name']),
    snapshot.orgs.map((org) => ({ vertex: ids.orgId(org.key), key: org.key, name: org.name })),
  );

  await run(
    'Repo',
    vertexStatement('Repo', ['key', 'org_key', 'name', 'language', 'lockfile_source']),
    snapshot.repos.map((repo) => ({
      vertex: ids.repoId(repo.key),
      key: repo.key,
      org_key: repo.org_key,
      name: repo.name,
      language: repo.language,
      lockfile_source: repo.lockfile_source,
    })),
  );

  await run(
    'LockfileSnapshot',
    vertexStatement('LockfileSnapshot', [
      'key',
      'repo_key',
      'repo_name',
      'captured_at',
      'superseded_at',
      'is_current',
      'source',
      'commit_sha',
    ]),
    snapshot.snapshots.map((snap) => ({
      vertex: ids.snapshotId(snap.key),
      key: snap.key,
      repo_key: snap.repo_key,
      repo_name: snap.repo_name,
      captured_at: snap.captured_at,
      superseded_at: snap.superseded_at,
      is_current: snap.is_current,
      source: snap.source,
      commit_sha: snap.commit_sha,
    })),
  );

  await run(
    'Advisory',
    vertexStatement('Advisory', ['key', 'package_key', 'summary', 'published', 'severity', 'affected_count']),
    snapshot.advisories.map((advisory) => ({
      vertex: ids.id('adv', advisory.id),
      key: advisory.id,
      package_key: advisory.package_key,
      summary: advisory.summary.slice(0, 500),
      published: advisory.published,
      severity: advisory.severity,
      affected_count: advisory.affected_version_keys.length,
    })),
  );

  // --- edges ---------------------------------------------------------------

  await run(
    'DEPENDS_ON',
    edgeStatement('Version', 'Package', 'DEPENDS_ON', ['range', 'kind']),
    snapshot.depends_on.map((edge) => ({
      source_vertex: ids.versionId(edge.from_version_key),
      destination_vertex: ids.packageId(edge.to_package_key),
      // `kind` is part of the identity: a manifest can list the same package
      // as both a prod and a peer dependency, with different ranges.
      relationship_vertex: ids.id(
        'e:DEPENDS_ON',
        `${edge.from_version_key}->${edge.to_package_key}:${edge.kind}`,
      ),
      range: edge.range,
      kind: edge.kind,
    })),
  );

  await run(
    'RESOLVED_TO',
    edgeStatement('Version', 'Version', 'RESOLVED_TO', []),
    snapshot.resolved_to.map((edge) => ({
      source_vertex: ids.versionId(edge.from_version_key),
      destination_vertex: ids.versionId(edge.to_version_key),
      relationship_vertex: ids.id('e:RESOLVED_TO', `${edge.from_version_key}->${edge.to_version_key}`),
    })),
  );

  await run(
    'MAINTAINS',
    edgeStatement('Maintainer', 'Package', 'MAINTAINS', []),
    snapshot.maintains.map((edge) => ({
      source_vertex: ids.maintainerId(edge.maintainer_key),
      destination_vertex: ids.packageId(edge.package_key),
      relationship_vertex: ids.id('e:MAINTAINS', `${edge.maintainer_key}->${edge.package_key}`),
    })),
  );

  await run(
    'RESOLVED',
    edgeStatement('LockfileSnapshot', 'Version', 'RESOLVED', ['direct']),
    snapshot.resolved.map((edge) => ({
      source_vertex: ids.snapshotId(edge.snapshot_key),
      destination_vertex: ids.versionId(edge.version_key),
      relationship_vertex: ids.id('e:RESOLVED', `${edge.snapshot_key}->${edge.version_key}`),
      direct: edge.direct,
    })),
  );

  // Direct dependencies get a second, narrower edge. See the comment on
  // `ResolvedEdge` for why the blast-radius traversal needs it.
  await run(
    'RESOLVED_DIRECT',
    edgeStatement('LockfileSnapshot', 'Version', 'RESOLVED_DIRECT', []),
    snapshot.resolved
      .filter((edge) => edge.direct)
      .map((edge) => ({
        source_vertex: ids.snapshotId(edge.snapshot_key),
        destination_vertex: ids.versionId(edge.version_key),
        relationship_vertex: ids.id(
          'e:RESOLVED_DIRECT',
          `${edge.snapshot_key}->${edge.version_key}`,
        ),
      })),
  );

  await run(
    'HAS_SNAPSHOT',
    edgeStatement('Repo', 'LockfileSnapshot', 'HAS_SNAPSHOT', []),
    snapshot.has_snapshot.map((edge) => ({
      source_vertex: ids.repoId(edge.repo_key),
      destination_vertex: ids.snapshotId(edge.snapshot_key),
      relationship_vertex: ids.id('e:HAS_SNAPSHOT', `${edge.repo_key}->${edge.snapshot_key}`),
    })),
  );

  await run(
    'AFFECTS',
    edgeStatement('Advisory', 'Version', 'AFFECTS', []),
    snapshot.advisories.flatMap((advisory) =>
      advisory.affected_version_keys.map((versionKey) => ({
        source_vertex: ids.id('adv', advisory.id),
        destination_vertex: ids.versionId(versionKey),
        relationship_vertex: ids.id('e:AFFECTS', `${advisory.id}->${versionKey}`),
      })),
    ),
  );

  await run(
    'NAME_SIMILAR_TO',
    edgeStatement('Package', 'Package', 'NAME_SIMILAR_TO', ['distance', 'score', 'reason']),
    snapshot.name_similar_to.map((edge) => ({
      source_vertex: ids.packageId(edge.from_package_key),
      destination_vertex: ids.packageId(edge.to_package_key),
      relationship_vertex: ids.id(
        'e:NAME_SIMILAR_TO',
        `${edge.from_package_key}->${edge.to_package_key}`,
      ),
      distance: edge.distance,
      score: edge.score,
      reason: edge.reason,
    })),
  );

  return stats;
}

/**
 * Compromise-window statement, shared by marking and clearing.
 *
 * Note this is the *vertex upsert* form (`MERGE ... SET`), not a `MATCH ...
 * SET`. HydraDB rejects both `UNWIND ... MATCH ... SET` ("UNWIND MATCH must end
 * in RETURN or DELETE") and any mutation followed by `RETURN` ("mutation
 * queries cannot continue with MATCH, RETURN, or WITH after writes"), so the
 * MERGE-by-id form is the only batched way to update existing nodes. MERGE
 * matches the node that already carries the id, and the trailing SET applies to
 * the matched node — re-asserting the `:Version` label is a no-op.
 */
const COMPROMISE_STATEMENT =
  'UNWIND $rows AS row MERGE (v {id: row.vertex}) SET v:Version, ' +
  'v.is_compromised = row.is_compromised, v.compromised_from = row.compromised_from, ' +
  'v.compromised_to = row.compromised_to, v.advisory_id = row.advisory_id';

export interface CompromiseMarking {
  versionId: number;
  from: number;
  to: number;
  advisoryId?: string;
}

/** Mark one version compromised for a window. */
export async function markCompromised(
  client: HydraClient,
  versionId: number,
  from: number,
  to: number,
  advisoryId = '',
): Promise<void> {
  await markManyCompromised(client, [{ versionId, from, to, advisoryId }]);
}

/** Mark many versions compromised in batched round trips — this is what the
 *  worm simulation uses as it propagates through the graph. */
export async function markManyCompromised(
  client: HydraClient,
  markings: readonly CompromiseMarking[],
): Promise<void> {
  if (markings.length === 0) return;
  await client.batch(
    COMPROMISE_STATEMENT,
    markings.map((marking) => ({
      vertex: marking.versionId,
      is_compromised: true,
      compromised_from: marking.from,
      compromised_to: marking.to,
      advisory_id: marking.advisoryId ?? '',
    })),
  );
}

/** Clear a compromise marking (used to reset between simulation runs). */
export async function clearCompromised(client: HydraClient, versionIds: number[]): Promise<void> {
  if (versionIds.length === 0) return;
  await client.batch(
    COMPROMISE_STATEMENT,
    versionIds.map((vertex) => ({
      vertex,
      is_compromised: false,
      compromised_from: 0,
      compromised_to: 0,
      advisory_id: '',
    })),
  );
}
