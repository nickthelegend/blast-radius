/**
 * Write idempotency keys.
 *
 * HydraDB derives a write's idempotency key from the request's `query_id`.
 * When the client omits it, graph-node assigns `http-query-<N>` from an
 * in-process counter that restarts at 1 on every restart — while the object
 * store still holds the keys from before. The next batch then collides with a
 * different payload under a reused key and the request fails outright:
 *
 *   idempotency key conflict for relationship-import request key
 *   http-query-94.unwind-relationship-merge
 *
 * So the client must always send its own unique id. These tests pin that.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { explainBoltFailure } from '../../packages/core/src/hydra/bolt.js';
import { HydraClient } from '../../packages/core/src/hydra/client.js';

const config = {
  httpUrl: 'http://127.0.0.1:1',
  authToken: 'x'.repeat(32),
  namespace: 'default',
  graphId: 'default',
  cellId: 'cell-0',
  timeoutMs: 5000,
  defaultConsistency: 'causal' as const,
};

const okResponse = () =>
  new Response(JSON.stringify({ columns: [], rows: [], read_epoch: 1, bookmark: null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('write idempotency key', () => {
  it('sends a query_id on every request', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return okResponse();
    });

    const client = new HydraClient(config);
    await client.query('MATCH (n) RETURN count(*) AS n');
    expect(typeof bodies[0]!.query_id).toBe('string');
    expect(String(bodies[0]!.query_id).length).toBeGreaterThan(20);
  });

  it('never reuses an id across different queries', async () => {
    const ids: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      ids.push(String(JSON.parse(String(init.body)).query_id));
      return okResponse();
    });

    const client = new HydraClient(config);
    for (let i = 0; i < 25; i++) await client.query(`MATCH (n {id: ${i}}) RETURN n.id AS id`);
    expect(new Set(ids).size).toBe(25);
  });

  it('reuses the SAME id across retries of one query', async () => {
    // A retried write is the same write and must land under the same key,
    // rather than being treated as a second, different one.
    const ids: string[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      ids.push(String(JSON.parse(String(init.body)).query_id));
      calls += 1;
      if (calls === 1) return new Response('{"error":{"message":"boom"}}', { status: 503 });
      return okResponse();
    });

    const client = new HydraClient(config);
    await client.query('UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:X', {
      parameters: { rows: [{ vertex: 1 }] },
    });
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('uses a fresh id for a batch of chunks', async () => {
    // Each chunk is a distinct write and must not collide with its siblings.
    const ids: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      ids.push(String(JSON.parse(String(init.body)).query_id));
      return okResponse();
    });

    const client = new HydraClient(config);
    const rows = Array.from({ length: 10 }, (_, i) => ({ vertex: i }));
    await client.batch('UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:X', rows, {
      chunkSize: 2,
    });
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
  });
});

describe('cursor pagination', () => {
  const page = (rows: unknown[][], nextCursor: number | null) =>
    new Response(
      JSON.stringify({ columns: ['k'], rows, read_epoch: 1, bookmark: null, next_cursor: nextCursor }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  const row = (v: string) => [{ type: 'string', value: v }];

  it('follows next_cursor until the server stops paginating', async () => {
    // The API caps a response at its page size and returns a cursor for the
    // rest. Reading only the first page is a silent truncation.
    const pages = [
      page([row('a'), row('b')], 2),
      page([row('c'), row('d')], 4),
      page([row('e')], null),
    ];
    let i = 0;
    vi.stubGlobal('fetch', async () => pages[i++]!);

    const client = new HydraClient(config);
    const result = await client.query('MATCH (v:Version) RETURN v.key AS k');
    expect(result.rows.length).toBe(5);
    expect(result.records.map((r) => r.k)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not paginate when next_cursor is null', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return page([row('only')], null); });
    const client = new HydraClient(config);
    const result = await client.query('MATCH (n) RETURN n.k AS k');
    expect(calls).toBe(1);
    expect(result.rows.length).toBe(1);
  });

  it('sends the cursor, and reuses the originating query id for continuations', async () => {
    // A cursor is scoped to the request that produced it — a fresh id is
    // rejected with "result cursor does not belong to this query request".
    const bodies: Array<Record<string, unknown>> = [];
    const pages = [page([row('a')], 7), page([row('b')], null)];
    let i = 0;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return pages[i++]!;
    });

    const client = new HydraClient(config);
    await client.query('MATCH (n) RETURN n.k AS k');
    expect(bodies[0]!.cursor).toBeUndefined();
    expect(bodies[1]!.cursor).toBe(7);
    expect(bodies[1]!.query_id).toBe(bodies[0]!.query_id);
  });

  it('uses a fresh query id after a client-side failure, not the stale one', async () => {
    // On an abort the server may still be running the query; resending the same
    // id is rejected with "query id <uuid> is already active".
    const ids: string[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      ids.push(String(JSON.parse(String(init.body)).query_id));
      calls++;
      if (calls === 1) throw new Error('aborted');
      return page([row('ok')], null);
    });

    const client = new HydraClient(config);
    await client.query('MATCH (n) RETURN n.k AS k');
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('bolt failure diagnosis', () => {
  it('explains an empty routing table instead of dumping the driver error', () => {
    const raw =
      'Could not perform discovery. No routing servers available. Known routing ' +
      'table: RoutingTable[database=default, routers=[], readers=[], writers=[]]';
    const explained = explainBoltFailure(raw);

    expect(explained).toContain('publishes no Bolt route');
    expect(explained).toContain('--force-recreate');
    // Honest about what is known: the remedy, not an invented cause.
    expect(explained).toContain('intermittently');
  });

  it('names the likely cause when nothing is listening', () => {
    expect(explainBoltFailure('connect ECONNREFUSED 127.0.0.1:7687')).toContain(
      'is the engine running?',
    );
  });

  it('passes an unrecognised error through unchanged', () => {
    expect(explainBoltFailure('something else entirely')).toBe('something else entirely');
  });
});
