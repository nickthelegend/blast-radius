/**
 * A small, exactly-known graph for the integration tests.
 *
 * Written into a high, reserved id range so it can coexist with a loaded demo
 * graph without either disturbing the other. Every assertion in the integration
 * suite is against a structure defined here, so an expectation can be read off
 * the fixture rather than off whatever npm happened to publish.
 *
 * Shape (edges point dependent -> dependency, as `RESOLVED_TO` does):
 *
 *   app-a  ──RESOLVED_DIRECT──▶ mid-1 ──▶ mid-2 ──▶ leaf      (depth 3 from leaf)
 *   app-b  ──RESOLVED_DIRECT──▶ mid-2 ──▶ leaf               (depth 2)
 *   app-c  ──RESOLVED_DIRECT──▶ leaf                          (depth 1, direct)
 *   app-d  ──RESOLVED_DIRECT──▶ safe                          (not exposed)
 *
 * Remediation fixtures: mid-1@2.0.0 exists and depends on nothing (a real fix
 * for app-a); mid-2@2.0.0 exists but still reaches the bad leaf (not a fix).
 *
 * Maintainers:  alice maintains leaf + sibling-1;  bob maintains leaf only.
 */
import { HydraClient, hydraConfigFrom, loadConfig } from '../../packages/core/src/index.js';

export const BASE = 990_000_000;

export const ids = {
  leaf: BASE + 1,
  mid1: BASE + 2,
  mid2: BASE + 3,
  safe: BASE + 4,
  sibling1: BASE + 5,
  // A newer mid-1 that dropped its dependency on the bad leaf — the fix the
  // remediation planner should find for app-a.
  mid1v2: BASE + 6,
  // A newer mid-2 that still depends on the bad leaf, so it is NOT a fix.
  mid2v2: BASE + 7,

  pkgLeaf: BASE + 20,
  pkgSibling: BASE + 21,

  maintainerAlice: BASE + 30,
  maintainerBob: BASE + 31,

  repoA: BASE + 40,
  repoB: BASE + 41,
  repoC: BASE + 42,
  repoD: BASE + 43,

  // Snapshot ids. `snapA1` is captured inside the compromise window.
  snapA: BASE + 50,
  snapB: BASE + 51,
  snapC: BASE + 52,
  snapD: BASE + 53,
  // Boundary snapshots for the Time Machine, all owned by repoB.
  snapAtStart: BASE + 60,
  snapAtEnd: BASE + 61,
  snapJustBefore: BASE + 62,
  snapJustAfter: BASE + 63,
  snapMiddleSuperseded: BASE + 64,
};

/** The compromise window used by every Time Machine assertion. */
export const WINDOW_FROM = Date.parse('2026-08-14T09:00:00Z');
export const WINDOW_TO = Date.parse('2026-08-14T09:06:00Z');

export function testClient(): HydraClient {
  const config = loadConfig();
  return new HydraClient(hydraConfigFrom(config));
}

export async function hydraAvailable(client: HydraClient): Promise<boolean> {
  const config = loadConfig();
  return client.ready(config.hydra.adminUrl);
}

const vertex = (label: string, props: string[]) =>
  `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:${label}` +
  (props.length ? `, ${props.map((p) => `n.${p} = row.${p}`).join(', ')}` : '');

const edge = (from: string, to: string, type: string, props: string[] = []) =>
  `UNWIND $rows AS row MATCH (s:${from} {id: row.source_vertex}), (d:${to} {id: row.destination_vertex}) ` +
  `MERGE (s)-[r:${type} {id: row.relationship_vertex}]->(d)` +
  (props.length ? ` SET ${props.map((p) => `r.${p} = row.${p}`).join(', ')}` : '');

let relationshipId = BASE + 100_000;
const nextRel = () => ++relationshipId;

export async function buildFixture(client: HydraClient): Promise<void> {
  await teardownFixture(client);
  relationshipId = BASE + 100_000;

  const version = (vertexId: number, name: string, versionString: string, compromised = false) => ({
    vertex: vertexId,
    key: `test:${name}@${versionString}`,
    package_key: `test:${name}`,
    package_name: name,
    ecosystem: 'test',
    version_string: versionString,
    published_at: Date.parse('2026-01-01T00:00:00Z'),
    is_compromised: compromised,
    compromised_from: compromised ? WINDOW_FROM : 0,
    compromised_to: compromised ? WINDOW_TO : 0,
    advisory_id: compromised ? 'TEST-0001' : '',
  });

  await client.query(
    vertex('Version', [
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
    {
      parameters: {
        rows: [
          version(ids.leaf, 'leaf', '1.0.0', true),
          version(ids.mid1, 'mid-1', '1.0.0'),
          version(ids.mid2, 'mid-2', '1.0.0'),
          version(ids.safe, 'safe', '1.0.0'),
          version(ids.sibling1, 'sibling-1', '1.0.0'),
          version(ids.mid1v2, 'mid-1', '2.0.0'),
          version(ids.mid2v2, 'mid-2', '2.0.0'),
        ],
      },
    },
  );

  await client.query(
    vertex('Package', ['key', 'name', 'ecosystem', 'downloads', 'created_at', 'dependent_count']),
    {
      parameters: {
        rows: [
          {
            vertex: ids.pkgLeaf,
            key: 'test:leaf',
            name: 'leaf',
            ecosystem: 'test',
            downloads: 100,
            created_at: 0,
            dependent_count: 2,
          },
          {
            vertex: ids.pkgSibling,
            key: 'test:sibling-1',
            name: 'sibling-1',
            ecosystem: 'test',
            downloads: 5,
            created_at: 0,
            dependent_count: 0,
          },
        ],
      },
    },
  );

  await client.query(vertex('Maintainer', ['key', 'username', 'email_hash', 'ecosystem']), {
    parameters: {
      rows: [
        {
          vertex: ids.maintainerAlice,
          key: 'test:alice',
          username: 'alice',
          email_hash: 'aaaa',
          ecosystem: 'test',
        },
        {
          vertex: ids.maintainerBob,
          key: 'test:bob',
          username: 'bob',
          email_hash: 'bbbb',
          ecosystem: 'test',
        },
      ],
    },
  });

  await client.query(vertex('Repo', ['key', 'org_key', 'name', 'language', 'lockfile_source']), {
    parameters: {
      rows: [
        ['app-a', ids.repoA],
        ['app-b', ids.repoB],
        ['app-c', ids.repoC],
        ['app-d', ids.repoD],
      ].map(([name, vertexId]) => ({
        vertex: vertexId,
        key: `test-org/${name as string}`,
        org_key: 'test-org',
        name: name as string,
        language: 'typescript',
        lockfile_source: 'package-lock.json',
      })),
    },
  });

  const snapshot = (
    vertexId: number,
    repoName: string,
    capturedAt: number,
    isCurrent: boolean,
    supersededAt = 0,
  ) => ({
    vertex: vertexId,
    key: `test-org/${repoName}@${new Date(capturedAt).toISOString()}`,
    repo_key: `test-org/${repoName}`,
    repo_name: repoName,
    captured_at: capturedAt,
    superseded_at: supersededAt,
    is_current: isCurrent,
    source: 'package-lock.json',
    commit_sha: 'deadbeef',
  });

  const day = 86_400_000;
  await client.query(
    vertex('LockfileSnapshot', [
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
          snapshot(ids.snapA, 'app-a', WINDOW_FROM + 60_000, true),
          snapshot(ids.snapB, 'app-b', WINDOW_FROM + 120_000, true),
          snapshot(ids.snapC, 'app-c', WINDOW_FROM + 180_000, true),
          snapshot(ids.snapD, 'app-d', WINDOW_FROM + 240_000, true),
          // Boundary fixtures — all belong to app-b's history, none current.
          snapshot(ids.snapAtStart, 'app-b', WINDOW_FROM, false, WINDOW_TO),
          snapshot(ids.snapAtEnd, 'app-b', WINDOW_TO, false, WINDOW_TO + day),
          snapshot(ids.snapJustBefore, 'app-b', WINDOW_FROM - 1, false, WINDOW_FROM),
          snapshot(ids.snapJustAfter, 'app-b', WINDOW_TO + 1, false, WINDOW_TO + day),
          snapshot(ids.snapMiddleSuperseded, 'app-b', WINDOW_FROM + 30_000, false, WINDOW_TO + day),
        ],
      },
    },
  );

  // --- edges ---------------------------------------------------------------

  await client.query(edge('Version', 'Version', 'RESOLVED_TO'), {
    parameters: {
      rows: [
        { source_vertex: ids.mid1, destination_vertex: ids.mid2, relationship_vertex: nextRel() },
        { source_vertex: ids.mid2, destination_vertex: ids.leaf, relationship_vertex: nextRel() },
        // mid-1@2.0.0 depends on nothing — it is the clean upgrade.
        // mid-2@2.0.0 still reaches the bad leaf, so it is not a fix.
        { source_vertex: ids.mid2v2, destination_vertex: ids.leaf, relationship_vertex: nextRel() },
      ],
    },
  });

  await client.query(edge('LockfileSnapshot', 'Version', 'RESOLVED_DIRECT'), {
    parameters: {
      rows: [
        { source_vertex: ids.snapA, destination_vertex: ids.mid1, relationship_vertex: nextRel() },
        { source_vertex: ids.snapB, destination_vertex: ids.mid2, relationship_vertex: nextRel() },
        { source_vertex: ids.snapC, destination_vertex: ids.leaf, relationship_vertex: nextRel() },
        { source_vertex: ids.snapD, destination_vertex: ids.safe, relationship_vertex: nextRel() },
      ],
    },
  });

  // Full pinned sets, including the boundary snapshots that pin the bad leaf.
  await client.query(edge('LockfileSnapshot', 'Version', 'RESOLVED', ['direct']), {
    parameters: {
      rows: [
        { source_vertex: ids.snapA, destination_vertex: ids.leaf, direct: false },
        { source_vertex: ids.snapB, destination_vertex: ids.leaf, direct: false },
        { source_vertex: ids.snapC, destination_vertex: ids.leaf, direct: true },
        { source_vertex: ids.snapD, destination_vertex: ids.safe, direct: true },
        { source_vertex: ids.snapAtStart, destination_vertex: ids.leaf, direct: true },
        { source_vertex: ids.snapAtEnd, destination_vertex: ids.leaf, direct: true },
        { source_vertex: ids.snapJustBefore, destination_vertex: ids.leaf, direct: true },
        { source_vertex: ids.snapJustAfter, destination_vertex: ids.leaf, direct: true },
        { source_vertex: ids.snapMiddleSuperseded, destination_vertex: ids.leaf, direct: true },
      ].map((row) => ({ ...row, relationship_vertex: nextRel() })),
    },
  });

  await client.query(edge('Repo', 'LockfileSnapshot', 'HAS_SNAPSHOT'), {
    parameters: {
      rows: [
        { source_vertex: ids.repoA, destination_vertex: ids.snapA },
        { source_vertex: ids.repoB, destination_vertex: ids.snapB },
        { source_vertex: ids.repoC, destination_vertex: ids.snapC },
        { source_vertex: ids.repoD, destination_vertex: ids.snapD },
        { source_vertex: ids.repoB, destination_vertex: ids.snapAtStart },
        { source_vertex: ids.repoB, destination_vertex: ids.snapAtEnd },
        { source_vertex: ids.repoB, destination_vertex: ids.snapJustBefore },
        { source_vertex: ids.repoB, destination_vertex: ids.snapJustAfter },
        { source_vertex: ids.repoB, destination_vertex: ids.snapMiddleSuperseded },
      ].map((row) => ({ ...row, relationship_vertex: nextRel() })),
    },
  });

  await client.query(edge('Maintainer', 'Package', 'MAINTAINS'), {
    parameters: {
      rows: [
        {
          source_vertex: ids.maintainerAlice,
          destination_vertex: ids.pkgLeaf,
          relationship_vertex: nextRel(),
        },
        {
          source_vertex: ids.maintainerAlice,
          destination_vertex: ids.pkgSibling,
          relationship_vertex: nextRel(),
        },
        {
          source_vertex: ids.maintainerBob,
          destination_vertex: ids.pkgLeaf,
          relationship_vertex: nextRel(),
        },
      ],
    },
  });
}

export async function teardownFixture(client: HydraClient): Promise<void> {
  const rows = Object.values(ids).map((vertexId) => ({ vertex: vertexId }));
  await client.query('UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n', {
    parameters: { rows },
  });
}
