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
