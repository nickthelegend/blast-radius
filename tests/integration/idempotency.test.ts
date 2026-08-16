import { describe, expect, it } from 'vitest';

import { HydraClient, hydraConfigFrom, loadConfig } from '@blast/core';

/**
 * Exactly-once, demonstrated rather than asserted.
 *
 * The loader claims to be safely re-runnable: every write is a MERGE keyed on a
 * deterministic id, so replaying an ingest converges instead of duplicating.
 * That claim is load-bearing — `blastradius load` is the documented recovery
 * path, and this session actually had to use it after the local stack lost its
 * volumes. A claim that recovery is safe should be tested, not trusted.
 */

const client = new HydraClient(hydraConfigFrom(loadConfig()));
const LABEL = 'ReplayProbe';

const count = async (): Promise<number> => {
  const result = await client.query(`MATCH (n:${LABEL}) RETURN count(*) AS n`, {
    consistency: 'strong',
  });
  return typeof result.records[0]?.n === 'number' ? result.records[0].n : -1;
};

describe('write idempotency', () => {
  it('converges when the same batch is replayed', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      vertex: 990_000_000 + index,
      marker: `row-${index}`,
    }));
    const statement = `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:${LABEL}, n.marker = row.marker`;

    await client.query(`MATCH (n:${LABEL}) DETACH DELETE n`, { timeoutMs: 60_000 });

    const first = await client.batch(statement, rows);
    const afterFirst = await count();

    // Replay the identical batch three times. A non-idempotent write would
    // multiply the row count; a correct one lands on the same number.
    await client.batch(statement, rows);
    await client.batch(statement, rows);
    const third = await client.batch(statement, rows);
    const afterReplays = await count();

    expect(afterFirst).toBe(25);
    expect(afterReplays).toBe(25);
    expect(first.written).toBe(25);
    expect(third.bookmark).toBeTruthy();

    await client.query(`MATCH (n:${LABEL}) DETACH DELETE n`, { timeoutMs: 60_000 });
  }, 120_000);

  it('is safe when a replay interleaves with a read of its own write', async () => {
    const id = 991_000_001;
    const statement = `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:${LABEL}, n.marker = row.marker`;

    const a = await client.batch(statement, [{ vertex: id, marker: 'first' }]);
    const b = await client.batch(statement, [{ vertex: id, marker: 'second' }]);

    // Pinned to the second write's epoch, the read must see 'second' — not a
    // stale 'first', and not two nodes.
    const read = await client.query(
      `MATCH (n:${LABEL}) WHERE n.id = $id RETURN n.marker AS marker`,
      { parameters: { id }, bookmark: b.bookmark },
    );

    expect(a.bookmark).toBeTruthy();
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.marker).toBe('second');

    await client.query(`MATCH (n:${LABEL}) DETACH DELETE n`, { timeoutMs: 60_000 });
  }, 120_000);
});
