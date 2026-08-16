/**
 * Idempotent schema setup and engine self-check.
 *
 * HydraDB has no DDL: labels are attached by `SET n:Label`, and property
 * indexes are maintained automatically (a `MSpaths` selector resolves through
 * `vertex_property_index_prefix` without anything being declared). So "schema
 * setup" here means two things that are worth doing on every startup:
 *
 *  1. Stamp a `:SchemaVersion` marker node so a stale graph is detectable.
 *  2. Actively verify that the engine still supports each feature Blast Radius
 *     depends on. These are cheap, and they turn a silent wrong answer — the
 *     failure mode that matters for a security tool — into a loud startup error.
 */
import type { HydraClient } from './client.js';
import { EDGE_TYPES, NODE_LABELS } from '../model/types.js';

export const SCHEMA_VERSION = 1;
/** Reserved id for the schema marker. Real entities start at 1 and grow up;
 *  this sits far above any plausible allocation. */
const SCHEMA_MARKER_ID = 999_999_999;

export interface SchemaCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function applySchema(client: HydraClient): Promise<void> {
  await client.query(
    'UNWIND $rows AS row MERGE (n {id: row.vertex}) ' +
      'SET n:SchemaVersion, n.version = row.version, n.applied_at = row.applied_at, n.labels = row.labels, n.edges = row.edges',
    {
      parameters: {
        rows: [
          {
            vertex: SCHEMA_MARKER_ID,
            version: SCHEMA_VERSION,
            applied_at: Date.now(),
            labels: NODE_LABELS.join(','),
            edges: EDGE_TYPES.join(','),
          },
        ],
      },
    },
  );
}

export async function readSchemaVersion(client: HydraClient): Promise<number | null> {
  const result = await client.query(
    `MATCH (n:SchemaVersion {id: ${SCHEMA_MARKER_ID}}) RETURN n.version AS version`,
  );
  const version = result.records[0]?.version;
  return typeof version === 'number' ? version : null;
}

/**
 * Verify the engine's Cypher subset still covers what the product needs.
 * Runs against a scratch id range so it never touches real data.
 */
export async function verifyEngineCapabilities(client: HydraClient): Promise<SchemaCheck[]> {
  const checks: SchemaCheck[] = [];
  const base = 999_000_000;
  const a = base + 1;
  const b = base + 2;
  const c = base + 3;

  const record = async (name: string, run: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await record('batched UNWIND vertex upsert', async () => {
    await client.query(
      'UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:BlastProbe, n.key = row.key, n.t = row.t',
      {
        parameters: {
          rows: [
            { vertex: a, key: 'probe-a', t: 1000 },
            { vertex: b, key: 'probe-b', t: 2000 },
            { vertex: c, key: 'probe-c', t: 3000 },
          ],
        },
      },
    );
    return '3 rows in one round trip';
  });

  await record('batched UNWIND edge merge (idempotent)', async () => {
    const rows = [
      { source_vertex: a, destination_vertex: b, relationship_vertex: base + 11, weight: 1 },
      { source_vertex: b, destination_vertex: c, relationship_vertex: base + 12, weight: 1 },
    ];
    // Relationship SET values must read from the row map — a literal is
    // rejected with "UNWIND relationship SET values must read from the row map".
    const statement =
      'UNWIND $rows AS row MATCH (s:BlastProbe {id: row.source_vertex}), (d:BlastProbe {id: row.destination_vertex}) ' +
      'MERGE (s)-[r:BLAST_PROBE_EDGE {id: row.relationship_vertex}]->(d) SET r.weight = row.weight';
    await client.query(statement, { parameters: { rows } });
    await client.query(statement, { parameters: { rows } });
    const count = await client.query(
      `MATCH (s:BlastProbe {id: ${a}})-[r:BLAST_PROBE_EDGE]->(d) RETURN count(*) AS n`,
    );
    const n = count.records[0]?.n;
    if (n !== 1) throw new Error(`expected 1 edge after two merges, found ${String(n)}`);
    return 'edge merge is idempotent';
  });

  await record('integer range filter (Time Machine window)', async () => {
    const result = await client.query(
      'MATCH (n:BlastProbe) WHERE n.t >= 1500 AND n.t <= 2500 RETURN n.id AS id',
    );
    if (result.rows.length !== 1) {
      throw new Error(`expected 1 row inside [1500,2500], got ${result.rows.length}`);
    }
    return 'inclusive >= / <= window works';
  });

  await record('algo.SSpaths reverse traversal', async () => {
    const result = await client.query(
      `CALL algo.SSpaths({sourceNode: ${c}, relTypes: ['BLAST_PROBE_EDGE'], ` +
        `relDirection: 'incoming', maxLen: 4, pathCount: 500, resultLimit: 500}) YIELD path RETURN path`,
    );
    // c <- b <- a, so both are reachable walking edges backwards.
    if (result.rows.length !== 2) {
      throw new Error(`expected 2 reverse paths from the probe sink, got ${result.rows.length}`);
    }
    return '2 dependents found by walking edges backwards';
  });

  await record('algo.SSpaths pathCount is a total budget', async () => {
    const result = await client.query(
      `CALL algo.SSpaths({sourceNode: ${c}, relTypes: ['BLAST_PROBE_EDGE'], ` +
        `relDirection: 'incoming', maxLen: 4, pathCount: 1}) YIELD path RETURN path`,
    );
    if (result.rows.length !== 1) {
      throw new Error(
        `pathCount semantics changed: expected pathCount:1 to truncate to 1 path, got ${result.rows.length}`,
      );
    }
    return 'confirmed: pathCount truncates silently, so Blast Radius always sets it high';
  });

  await record('algo.MSpaths indexed selectors', async () => {
    const result = await client.query(
      `CALL algo.MSpaths({sourceLabel: 'BlastProbe', sourceProperty: 'key', sourceValues: ['probe-c'], ` +
        `targetLabel: 'BlastProbe', targetProperty: 'key', targetValues: ['probe-a'], pairwise: false, ` +
        `relTypes: ['BLAST_PROBE_EDGE'], relDirection: 'incoming', maxLen: 4, pathCount: 500, ` +
        `resultLimit: 500}) YIELD path RETURN path`,
    );
    if (result.rows.length !== 1) {
      throw new Error(`expected 1 path from probe-c back to probe-a, got ${result.rows.length}`);
    }
    return 'string-property selectors resolve without any declared index';
  });

  await record('strong consistency read', async () => {
    const result = await client.query('MATCH (n:BlastProbe) RETURN count(*) AS n', {
      consistency: 'strong',
    });
    return `pinned snapshot returned ${String(result.records[0]?.n)} probe nodes`;
  });

  // Clean up the scratch range regardless of what failed above.
  try {
    await client.query('UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n', {
      parameters: { rows: [{ vertex: a }, { vertex: b }, { vertex: c }] },
    });
  } catch {
    /* best effort */
  }

  return checks;
}

/**
 * Remove every Blast Radius node.
 *
 * `DETACH DELETE` also removes each node's edges, which makes it expensive on
 * the high-degree nodes in a dependency graph — a popular package version has
 * hundreds of incoming `RESOLVED_TO` edges. Deletes therefore run in small
 * batches with a much longer timeout than an ordinary read; the default 30s
 * request timeout will abort partway through and leave the graph half-cleared.
 *
 * For a full wipe, `make db-reset` (which recreates the storage volume) is far
 * faster and is what `make demo` uses. This exists for clearing a graph in
 * place without restarting the server.
 */
export async function resetGraph(
  client: HydraClient,
  options: { onProgress?: (label: string, deleted: number) => void } = {},
): Promise<number> {
  let deleted = 0;
  const timeoutMs = 300_000;

  for (const label of [...NODE_LABELS, 'SchemaVersion']) {
    for (;;) {
      const result = await client.query(`MATCH (n:${label}) RETURN n.id AS id LIMIT 1000`, {
        timeoutMs,
      });
      if (result.rows.length === 0) break;
      const rows = result.records
        .map((record) => record.id)
        .filter((id): id is number => typeof id === 'number')
        .map((id) => ({ vertex: id }));
      if (rows.length === 0) break;

      for (let offset = 0; offset < rows.length; offset += 100) {
        await client.query('UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n', {
          parameters: { rows: rows.slice(offset, offset + 100) },
          timeoutMs,
        });
      }
      deleted += rows.length;
      options.onProgress?.(label, deleted);
    }
  }
  return deleted;
}
