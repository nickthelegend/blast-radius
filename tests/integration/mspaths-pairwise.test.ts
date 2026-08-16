/**
 * Regression test pinning down a defect in this build of HydraDB.
 *
 * `algo.MSpaths` in `pairwise: true` mode silently drops any (source, target)
 * pair whose source vertex id is greater than its target's. The identical pair
 * returns its path in non-pairwise mode, and `algo.SSpaths` / `algo.SPpaths`
 * both find it too — so the path unambiguously exists and pairwise mode is
 * losing it.
 *
 * This matters because node ids are an internal allocation detail. Building the
 * multi-repo exposure check on pairwise mode would drop roughly half of all
 * exposures at random, with no error — the worst possible failure for a
 * security tool. Blast Radius therefore uses non-pairwise MSpaths, and this
 * test exists so the day the engine is fixed, it fails and says so.
 *
 * Reported upstream: github.com/hydra-db/hydradb
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GraphPath, HydraClient } from '../../packages/core/src/index.js';
import { hydraAvailable, testClient } from './fixture.js';

const client: HydraClient = testClient();
let available = false;

// A dedicated id range, isolated from the main fixture.
const BASE = 980_000_000;
const LOW = BASE + 1;
const HIGH = BASE + 2;

const paths = (records: Array<Record<string, unknown>>): number[][] =>
  records
    .map((record) => record.path as GraphPath | undefined)
    .filter((path): path is GraphPath => Boolean(path?.nodes))
    .map((path) => path.nodes.map((node) => node.id));

async function msPaths(source: string, target: string, pairwise: boolean, direction: string) {
  const result = await client.query(
    `CALL algo.MSpaths({sourceLabel: 'PairProbe', sourceProperty: 'key', ` +
      `sourceValues: ['${source}'], targetLabel: 'PairProbe', targetProperty: 'key', ` +
      `targetValues: ['${target}'], pairwise: ${pairwise}, relTypes: ['PAIR_EDGE'], ` +
      `relDirection: '${direction}', maxLen: 4, pathCount: 500, resultLimit: 500}) ` +
      `YIELD path RETURN path`,
  );
  return paths(result.records);
}

beforeAll(async () => {
  available = await hydraAvailable(client);
  if (!available) return;

  await client.query(
    'UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:PairProbe, n.key = row.key',
    {
      parameters: {
        rows: [
          { vertex: LOW, key: 'pair-low' },
          { vertex: HIGH, key: 'pair-high' },
        ],
      },
    },
  );
  // One edge, oriented from the HIGH id to the LOW id.
  await client.query(
    'UNWIND $rows AS row MATCH (s:PairProbe {id: row.source_vertex}), ' +
      '(d:PairProbe {id: row.destination_vertex}) ' +
      'MERGE (s)-[r:PAIR_EDGE {id: row.relationship_vertex}]->(d)',
    {
      parameters: {
        rows: [{ source_vertex: HIGH, destination_vertex: LOW, relationship_vertex: BASE + 10 }],
      },
    },
  );
});

afterAll(async () => {
  if (!available) return;
  await client.query('UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n', {
    parameters: { rows: [{ vertex: LOW }, { vertex: HIGH }] },
  });
});

describe('algo.MSpaths pairwise mode', () => {
  it('the path genuinely exists — SSpaths finds it', async () => {
    const result = await client.query(
      `CALL algo.SSpaths({sourceNode: ${HIGH}, relTypes: ['PAIR_EDGE'], relDirection: 'outgoing', ` +
        `maxLen: 4, pathCount: 500, resultLimit: 500}) YIELD path RETURN path`,
    );
    expect(paths(result.records)).toEqual([[HIGH, LOW]]);
  });

  it('the path genuinely exists — SPpaths finds it', async () => {
    const result = await client.query(
      `CALL algo.SPpaths({sourceNode: ${HIGH}, targetNode: ${LOW}, relTypes: ['PAIR_EDGE'], ` +
        `relDirection: 'outgoing', maxLen: 4, pathCount: 500}) YIELD path RETURN path`,
    );
    expect(paths(result.records)).toEqual([[HIGH, LOW]]);
  });

  it('non-pairwise MSpaths finds it (this is what Blast Radius uses)', async () => {
    expect(await msPaths('pair-high', 'pair-low', false, 'outgoing')).toEqual([[HIGH, LOW]]);
  });

  it('non-pairwise MSpaths finds it in the reverse orientation too', async () => {
    expect(await msPaths('pair-low', 'pair-high', false, 'incoming')).toEqual([[LOW, HIGH]]);
  });

  it('pairwise MSpaths finds the pair when source id < target id', async () => {
    expect(await msPaths('pair-low', 'pair-high', true, 'incoming')).toEqual([[LOW, HIGH]]);
  });

  it('KNOWN DEFECT: pairwise MSpaths drops the pair when source id > target id', async () => {
    // Same edge, same direction as the passing non-pairwise case above.
    expect(await msPaths('pair-high', 'pair-low', true, 'outgoing')).toEqual([]);
    // Not a direction problem — every direction loses it.
    expect(await msPaths('pair-high', 'pair-low', true, 'incoming')).toEqual([]);
    expect(await msPaths('pair-high', 'pair-low', true, 'both')).toEqual([]);
  });
});
