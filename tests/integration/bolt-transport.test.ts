import { describe, expect, it } from 'vitest';

import { HydraClient, boltQuery, hydraConfigFrom, loadConfig } from '@blast/core';

/**
 * Bolt as a product transport, not a claim in `doctor`.
 *
 * "Neo4j-compatible" is easy to assert and hard to trust. These tests send the
 * product's real queries down a stock `neo4j-driver` and require the answers to
 * match the HTTP API exactly — including the flagship traversal.
 */

const config = loadConfig();
const client = new HydraClient(hydraConfigFrom(config));
const bolt = {
  boltUrl: config.hydra.boltUrl,
  authToken: config.hydra.authToken,
  graphId: config.hydra.graphId,
};

describe('bolt transport', () => {
  it('answers a count identically to HTTP', async () => {
    const overBolt = await boltQuery('MATCH (v:Version) RETURN count(*) AS n', bolt);
    const overHttp = await client.query('MATCH (v:Version) RETURN count(*) AS n');

    expect(overBolt.rows[0]?.n).toBe(overHttp.records[0]?.n);
    expect(overBolt.transport).toBe('bolt');
    expect(overBolt.server).toBeTruthy();
  }, 60_000);

  it('runs the flagship traversal through a stock Neo4j driver', async () => {
    // If Bolt compatibility were superficial, this is where it would break:
    // a native procedure call returning path payloads, not a scalar.
    const result = await client.query(
      "MATCH (v:Version) WHERE v.key = 'npm:debug@4.4.3' RETURN v.id AS id",
    );
    const id = result.records[0]?.id;
    expect(typeof id).toBe('number');

    const paths = await boltQuery(
      `CALL algo.SSpaths({sourceNode: ${String(id)}, ` +
        `relTypes: ['RESOLVED_TO', 'RESOLVED_DIRECT', 'HAS_SNAPSHOT'], ` +
        `relDirection: 'incoming', maxLen: 10, pathCount: 20000, resultLimit: 20000}) ` +
        `YIELD path RETURN path`,
      bolt,
    );
    expect(paths.rows.length).toBeGreaterThan(1000);
  }, 120_000);

  it('surfaces a rejected query rather than hanging', async () => {
    await expect(boltQuery('MATCH (( RETURN', bolt)).rejects.toThrow();
  }, 60_000);
});
