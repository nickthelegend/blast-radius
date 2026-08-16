/**
 * Scan a real repository into the graph.
 *
 * Everything written here comes from the repository on disk: the package names
 * and versions are what its lockfile pins, the resolution edges are npm's own
 * hoisting resolution over that lockfile, the direct-dependency set is what its
 * `package.json` declares, and `captured_at` is the lockfile's mtime.
 *
 * Re-scanning the same repo appends a *new* `LockfileSnapshot` and supersedes
 * the previous one, so the repo accumulates genuine lockfile history — which is
 * exactly what the Time Machine queries. Point this at a repo, change a
 * dependency, scan again, and the history is real.
 */
import type { HydraClient } from '../hydra/client.js';
import type { IdRegistry } from '../model/ids.js';
import type { LockfileSource } from '../model/types.js';
import { packageKey, repoKey as makeRepoKey, snapshotKey as makeSnapshotKey, versionKey } from '../model/types.js';
import { parseLockfileAt, type ParsedLockfile } from './lockfile.js';

export interface ScanResult {
  repoKey: string;
  repoName: string;
  snapshotKey: string;
  lockfile: string;
  lockfileKind: LockfileSource;
  capturedAt: number;
  packagesWritten: number;
  versionsWritten: number;
  resolvedEdges: number;
  resolvedToEdges: number;
  directDependencies: number;
  /** Versions already present in the graph — i.e. shared with the crawl. */
  versionsAlreadyKnown: number;
  supersededSnapshotKey: string | null;
  elapsedMs: number;
}

export interface ScanOptions {
  directory: string;
  orgKey: string;
  /** Overrides the repo name derived from package.json. */
  repoName?: string;
  /** Overrides the lockfile mtime as the capture instant. */
  capturedAt?: number;
  onLog?: (message: string) => void;
}

const vertexStatement = (label: string, properties: string[]): string =>
  `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:${label}` +
  (properties.length ? `, ${properties.map((p) => `n.${p} = row.${p}`).join(', ')}` : '');

const edgeStatement = (
  sourceLabel: string,
  targetLabel: string,
  type: string,
  properties: string[] = [],
): string =>
  `UNWIND $rows AS row ` +
  `MATCH (s:${sourceLabel} {id: row.source_vertex}), (d:${targetLabel} {id: row.destination_vertex}) ` +
  `MERGE (s)-[r:${type} {id: row.relationship_vertex}]->(d)` +
  (properties.length ? ` SET ${properties.map((p) => `r.${p} = row.${p}`).join(', ')}` : '');

export async function scanRepository(
  client: HydraClient,
  ids: IdRegistry,
  options: ScanOptions,
): Promise<ScanResult> {
  const startedAt = performance.now();
  const log = options.onLog ?? (() => {});

  const parsed: ParsedLockfile = parseLockfileAt(options.directory);
  log(`parsed ${parsed.kind}: ${parsed.entries.length} packages, ${parsed.resolutions.length} resolutions`);

  const repoName = options.repoName ?? parsed.projectName;
  const repoKeyValue = makeRepoKey(options.orgKey, repoName);
  const capturedAt = Math.round(options.capturedAt ?? parsed.capturedAt);
  const snapshotKeyValue = makeSnapshotKey(repoKeyValue, capturedAt);

  // --- which of these versions does the graph already know about? ----------
  // Reported honestly: overlap with the crawled graph is what makes a scanned
  // repo's exposure connect to the wider ecosystem rather than sit isolated.
  const uniqueVersions = new Map<string, { name: string; version: string }>();
  for (const entry of parsed.entries) {
    uniqueVersions.set(versionKey('npm', entry.name, entry.version), {
      name: entry.name,
      version: entry.version,
    });
  }

  // --- org + repo ----------------------------------------------------------
  await client.query(vertexStatement('Org', ['key', 'name']), {
    parameters: {
      rows: [{ vertex: ids.orgId(options.orgKey), key: options.orgKey, name: options.orgKey }],
    },
  });

  await client.query(
    vertexStatement('Repo', ['key', 'org_key', 'name', 'language', 'lockfile_source']),
    {
      parameters: {
        rows: [
          {
            vertex: ids.repoId(repoKeyValue),
            key: repoKeyValue,
            org_key: options.orgKey,
            name: repoName,
            language: 'javascript',
            lockfile_source: parsed.kind,
          },
        ],
      },
    },
  );

  // --- packages and versions ----------------------------------------------
  const packageRows = new Map<string, Record<string, unknown>>();
  const versionRows: Record<string, unknown>[] = [];

  for (const [key, { name, version }] of uniqueVersions) {
    const pkgKey = packageKey('npm', name);
    if (!packageRows.has(pkgKey)) {
      packageRows.set(pkgKey, {
        vertex: ids.packageId(pkgKey),
        key: pkgKey,
        name,
        ecosystem: 'npm',
        downloads: 0,
        created_at: 0,
        dependent_count: 0,
      });
    }
    versionRows.push({
      vertex: ids.versionId(key),
      key,
      package_key: pkgKey,
      package_name: name,
      ecosystem: 'npm',
      version_string: version,
      published_at: 0,
      is_compromised: false,
      compromised_from: 0,
      compromised_to: 0,
      advisory_id: '',
    });
  }

  // Only write versions the graph does not already have. A version already
  // carrying real registry metadata — publish date, advisory id — must not have
  // it flattened by a lockfile scan, which knows only the name and version.
  //
  // The check is against the live graph rather than the local id map, because a
  // fresh clone has no id map while the graph may already be fully loaded.
  const existing = await existingKeys(client);
  const toWriteVersions = versionRows.filter((row) => !existing.versions.has(String(row.key)));
  const toWritePackages = [...packageRows.values()].filter(
    (row) => !existing.packages.has(String(row.key)),
  );

  if (toWritePackages.length > 0) {
    await client.batch(
      vertexStatement('Package', [
        'key',
        'name',
        'ecosystem',
        'downloads',
        'created_at',
        'dependent_count',
      ]),
      toWritePackages,
    );
  }
  if (toWriteVersions.length > 0) {
    await client.batch(
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
      toWriteVersions,
    );
  }
  log(`wrote ${toWritePackages.length} new packages, ${toWriteVersions.length} new versions`);

  // --- resolution edges, straight from the lockfile ------------------------
  const resolvedToRows = new Map<string, Record<string, unknown>>();
  for (const edge of parsed.resolutions) {
    const fromKey = versionKey('npm', edge.from.name, edge.from.version);
    const toKey = versionKey('npm', edge.to.name, edge.to.version);
    if (fromKey === toKey) continue;
    const relKey = `${fromKey}->${toKey}`;
    if (resolvedToRows.has(relKey)) continue;
    resolvedToRows.set(relKey, {
      source_vertex: ids.versionId(fromKey),
      destination_vertex: ids.versionId(toKey),
      relationship_vertex: ids.id('e:RESOLVED_TO', relKey),
    });
  }
  if (resolvedToRows.size > 0) {
    await client.batch(
      edgeStatement('Version', 'Version', 'RESOLVED_TO'),
      [...resolvedToRows.values()],
    );
  }

  // --- the snapshot itself -------------------------------------------------
  const previous = await currentSnapshotOf(client, repoKeyValue);

  await client.query(
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
    {
      parameters: {
        rows: [
          {
            vertex: ids.snapshotId(snapshotKeyValue),
            key: snapshotKeyValue,
            repo_key: repoKeyValue,
            repo_name: repoName,
            captured_at: capturedAt,
            superseded_at: 0,
            is_current: true,
            source: parsed.kind,
            commit_sha: '',
          },
        ],
      },
    },
  );

  // The previous snapshot stops being current the moment this one exists.
  if (previous && previous.key !== snapshotKeyValue) {
    await client.query(
      vertexStatement('LockfileSnapshot', ['superseded_at', 'is_current']),
      {
        parameters: {
          rows: [
            {
              vertex: ids.snapshotId(previous.key),
              superseded_at: capturedAt,
              is_current: false,
            },
          ],
        },
      },
    );
  }

  await client.query(edgeStatement('Repo', 'LockfileSnapshot', 'HAS_SNAPSHOT'), {
    parameters: {
      rows: [
        {
          source_vertex: ids.repoId(repoKeyValue),
          destination_vertex: ids.snapshotId(snapshotKeyValue),
          relationship_vertex: ids.id('e:HAS_SNAPSHOT', `${repoKeyValue}->${snapshotKeyValue}`),
        },
      ],
    },
  });

  // --- pinned set + direct dependencies ------------------------------------
  const directNames = new Set(parsed.directDependencies);
  const resolvedRows: Record<string, unknown>[] = [];
  const directRows: Record<string, unknown>[] = [];

  for (const [key, { name }] of uniqueVersions) {
    const isDirect = directNames.has(name);
    resolvedRows.push({
      source_vertex: ids.snapshotId(snapshotKeyValue),
      destination_vertex: ids.versionId(key),
      relationship_vertex: ids.id('e:RESOLVED', `${snapshotKeyValue}->${key}`),
      direct: isDirect,
    });
    if (isDirect) {
      directRows.push({
        source_vertex: ids.snapshotId(snapshotKeyValue),
        destination_vertex: ids.versionId(key),
        relationship_vertex: ids.id('e:RESOLVED_DIRECT', `${snapshotKeyValue}->${key}`),
      });
    }
  }

  await client.batch(
    edgeStatement('LockfileSnapshot', 'Version', 'RESOLVED', ['direct']),
    resolvedRows,
  );
  if (directRows.length > 0) {
    await client.batch(
      edgeStatement('LockfileSnapshot', 'Version', 'RESOLVED_DIRECT'),
      directRows,
    );
  }

  return {
    repoKey: repoKeyValue,
    repoName,
    snapshotKey: snapshotKeyValue,
    lockfile: parsed.file,
    lockfileKind: parsed.kind,
    capturedAt,
    packagesWritten: toWritePackages.length,
    versionsWritten: toWriteVersions.length,
    resolvedEdges: resolvedRows.length,
    resolvedToEdges: resolvedToRows.size,
    directDependencies: directRows.length,
    versionsAlreadyKnown: uniqueVersions.size - toWriteVersions.length,
    supersededSnapshotKey: previous?.key ?? null,
    elapsedMs: performance.now() - startedAt,
  };
}

/**
 * Every Package and Version key already in the graph.
 *
 * Read in one pass rather than one query per key: HydraDB's WHERE has no `IN`,
 * so a per-key check would be thousands of round trips for a 276-package
 * lockfile.
 */
async function existingKeys(
  client: HydraClient,
): Promise<{ versions: Set<string>; packages: Set<string> }> {
  const [versionResult, packageResult] = await Promise.all([
    client.query('MATCH (v:Version) RETURN v.key AS key'),
    client.query('MATCH (p:Package) RETURN p.key AS key'),
  ]);
  const collect = (records: Array<Record<string, unknown>>) =>
    new Set(
      records
        .map((record) => (typeof record.key === 'string' ? record.key : ''))
        .filter((key) => key !== ''),
    );
  return { versions: collect(versionResult.records), packages: collect(packageResult.records) };
}

async function currentSnapshotOf(
  client: HydraClient,
  repoKeyValue: string,
): Promise<{ key: string } | null> {
  const result = await client.query(
    'MATCH (s:LockfileSnapshot) WHERE s.repo_key = $repo_key AND s.is_current = true ' +
      'RETURN s.key AS key ORDER BY key LIMIT 1',
    { parameters: { repo_key: repoKeyValue } },
  );
  const key = result.records[0]?.key;
  return typeof key === 'string' ? { key } : null;
}

/* -------------------------------------------------------------------------- */
/* Forget a repository                                                        */
/* -------------------------------------------------------------------------- */

export interface ForgetResult {
  repoKey: string;
  repoName: string;
  snapshotsDeleted: number;
  /** True when the repository was not in the graph to begin with. */
  missing: boolean;
}

/**
 * Remove a scanned repository and its entire lockfile history.
 *
 * `scan` is append-only by design — re-scanning supersedes rather than
 * overwrites, because the superseded snapshots are exactly what the Time
 * Machine reads. That is right for history and wrong for mistakes: a repo
 * scanned under the wrong name, or a throwaway scan during testing, had no way
 * out short of resetting the whole graph and reloading it.
 *
 * Only `Repo` and its `LockfileSnapshot` nodes are removed. Packages and
 * versions are deliberately left alone: they are shared registry facts, not
 * this repository's property, and deleting them would silently corrupt every
 * other repo's chains.
 */
export async function forgetRepo(
  client: HydraClient,
  repoKeyOrName: string,
  orgKey: string,
): Promise<ForgetResult> {
  const key = repoKeyOrName.includes('/') ? repoKeyOrName : `${orgKey}/${repoKeyOrName}`;

  const found = await client.query(
    'MATCH (r:Repo) WHERE r.key = $key RETURN r.id AS id, r.name AS name LIMIT 1',
    { parameters: { key } },
  );
  const repo = found.records[0];
  if (!repo) {
    return { repoKey: key, repoName: '', snapshotsDeleted: 0, missing: true };
  }

  const snapshots = await client.query(
    'MATCH (s:LockfileSnapshot) WHERE s.repo_key = $key RETURN s.id AS id',
    { parameters: { key } },
  );
  const ids = snapshots.records
    .map((record) => record.id)
    .filter((id): id is number => typeof id === 'number');

  // DETACH DELETE takes the RESOLVED / RESOLVED_DIRECT / HAS_SNAPSHOT edges with
  // each node, so no orphaned relationship is left pointing at a deleted vertex.
  for (let offset = 0; offset < ids.length; offset += 100) {
    await client.query('UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n', {
      parameters: { rows: ids.slice(offset, offset + 100).map((vertex) => ({ vertex })) },
      timeoutMs: 120_000,
    });
  }

  await client.query('MATCH (n {id: $id}) DETACH DELETE n', {
    parameters: { id: repo.id },
    timeoutMs: 120_000,
  });

  return {
    repoKey: key,
    repoName: typeof repo.name === 'string' ? repo.name : '',
    snapshotsDeleted: ids.length,
    missing: false,
  };
}
