import { afterAll, describe, expect, it } from 'vitest';

import { HydraClient, classifyError, hydraConfigFrom, isRetryable, loadConfig } from '@blast/core';

/**
 * Read-your-writes, and the engine's failure taxonomy.
 *
 * Both of these were dead capabilities: the engine returns a `bookmark` on
 * every response and classes its failures seven ways, and this client used
 * neither. These tests pin the behaviour that makes them worth having.
 */

const config = loadConfig();
const client = new HydraClient(hydraConfigFrom(config));

const LABEL = 'BookmarkProbe';

afterAll(async () => {
  await client.query(`MATCH (n:${LABEL}) DETACH DELETE n`, { timeoutMs: 60_000 });
});

describe('bookmarks', () => {
  it('is returned on every query', async () => {
    const result = await client.query('MATCH (v:Version) RETURN count(*) AS n');
    expect(result.bookmark).toMatch(/^sgk:/);
    expect(client.lastBookmark).toBe(result.bookmark);
  });

  it('lets a read see a write that just happened', async () => {
    const id = Date.now();
    // The engine's upsert form: MERGE matches on id alone, labels via SET.
    const write = await client.batch(
      `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:${LABEL}, n.marker = row.marker`,
      [{ vertex: id, marker: 'written' }],
    );
    expect(write.bookmark).toBeTruthy();

    // The read is pinned to the write's own epoch, so it cannot answer from a
    // snapshot taken before the write landed.
    const read = await client.query(
      `MATCH (n:${LABEL}) WHERE n.id = $id RETURN n.marker AS marker`,
      { parameters: { id }, bookmark: write.bookmark },
    );
    expect(read.records[0]?.marker).toBe('written');
  });

  it('blocks rather than answering stale when the epoch is unreachable', async () => {
    const current = await client.query('MATCH (v:Version) RETURN count(*) AS n');
    const parts = (current.bookmark ?? '').split(':');
    const unreachable = [...parts.slice(0, -1), String(Number(parts.at(-1)) + 500_000)].join(':');

    // This is the proof the field is honoured at all: an epoch that does not
    // exist makes the engine wait instead of answering from the present.
    await expect(
      client.query('MATCH (v:Version) RETURN count(*) AS n', {
        bookmark: unreachable,
        timeoutMs: 3_000,
        retries: 0,
      }),
    ).rejects.toThrow();
  }, 20_000);
});

describe('error classification', () => {
  it('maps the engine vocabulary onto its classes', () => {
    expect(classifyError('invalid_request', 'OpenCypher parse error')).toBe('query');
    expect(classifyError(undefined, 'write conflict detected')).toBe('contention');
    expect(classifyError(undefined, 'not the leader for this cell')).toBe('routing');
    expect(classifyError(undefined, 'client_cursor_buffer_bytes exceeds limit')).toBe('admission');
    expect(classifyError(undefined, 'deadline exceeded')).toBe('timeout');
    expect(classifyError(undefined, 'snapshot too old')).toBe('freshness');
  });

  it('retries what can succeed and refuses what cannot', () => {
    // The distinction that matters: retrying a rejected query burns time and
    // hides the message; retrying an overloaded engine makes it worse.
    expect(isRetryable('contention')).toBe(true);
    expect(isRetryable('routing')).toBe(true);
    expect(isRetryable('query')).toBe(false);
    expect(isRetryable('admission')).toBe(false);
  });

  it('classifies a real rejection from the live engine', async () => {
    await expect(client.query('MATCH (( RETURN', { retries: 0 })).rejects.toMatchObject({
      errorClass: 'query',
      retryable: false,
    });
  });
});
