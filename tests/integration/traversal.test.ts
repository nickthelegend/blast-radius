/**
 * Traversal correctness at varying depths, against the known fixture graph.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { blastRadius, blastRadiusForRepos } from '../../packages/core/src/queries/blastRadius.js';
import { findVersion } from '../../packages/core/src/queries/lookup.js';
import type { HydraClient } from '../../packages/core/src/index.js';
import { buildFixture, hydraAvailable, teardownFixture, testClient } from './fixture.js';

const client: HydraClient = testClient();
let available = false;

const traversal = { maxDepth: 8, pathCount: 5000, resultLimit: 5000 };

beforeAll(async () => {
  available = await hydraAvailable(client);
  if (!available) return;
  await buildFixture(client);
});

afterAll(async () => {
  if (available) await teardownFixture(client);
});

describe('blast radius traversal', () => {
  it.runIf(true)('requires a running HydraDB', () => {
    if (!available) {
      throw new Error(
        'HydraDB is not reachable. Start it with `make db-up` before running the integration suite.',
      );
    }
  });

  it('finds every repo whose current lockfile pins the compromised version', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');
    expect(leaf).not.toBeNull();

    const report = await blastRadius(client, leaf!, traversal);
    const names = report.exposedRepos.map((exposure) => exposure.repoName).sort();

    // app-a, app-b and app-c all pin the bad leaf; app-d pins only `safe`.
    expect(names).toEqual(['app-a', 'app-b', 'app-c']);
    expect(names).not.toContain('app-d');
  });

  it('reports the true dependency depth for each repo', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');
    const report = await blastRadius(client, leaf!, traversal);
    const depths = Object.fromEntries(
      report.exposedRepos.map((exposure) => [exposure.repoName, exposure.depth]),
    );

    // app-c pins leaf directly; app-b is one hop away; app-a is two.
    expect(depths['app-c']).toBe(1);
    expect(depths['app-b']).toBe(2);
    expect(depths['app-a']).toBe(3);
  });

  it('returns the dependency chain that explains each exposure', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');
    const report = await blastRadius(client, leaf!, traversal);
    const appA = report.exposedRepos.find((exposure) => exposure.repoName === 'app-a');

    expect(appA).toBeDefined();
    expect(appA!.chainText).toBe('app-a -> mid-1@1.0.0 -> mid-2@1.0.0 -> leaf@1.0.0');
    expect(appA!.chain[0]!.kind).toBe('repo');
    expect(appA!.chain[appA!.chain.length - 1]!.key).toBe('test:leaf@1.0.0');
  });

  it('marks a direct pin as direct and a transitive one as not', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');
    const report = await blastRadius(client, leaf!, traversal);
    const byName = Object.fromEntries(
      report.exposedRepos.map((exposure) => [exposure.repoName, exposure]),
    );
    expect(byName['app-c']!.direct).toBe(true);
    expect(byName['app-a']!.direct).toBe(false);
  });

  it('drops repos beyond the configured depth', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');

    // maxDepth 1 leaves room for only the direct pin.
    const shallow = await blastRadius(client, leaf!, { ...traversal, maxDepth: 1 });
    const shallowNames = shallow.exposedRepos
      .filter((exposure) => exposure.chain.length > 2)
      .map((exposure) => exposure.repoName);
    expect(shallowNames).not.toContain('app-a');

    // maxDepth 2 brings app-b's chain into range but still not app-a's.
    const mid = await blastRadius(client, leaf!, { ...traversal, maxDepth: 2 });
    const midChains = Object.fromEntries(
      mid.exposedRepos.map((exposure) => [exposure.repoName, exposure.chainText]),
    );
    expect(midChains['app-b']).toBe('app-b -> mid-2@1.0.0 -> leaf@1.0.0');
  });

  it('flags truncation instead of silently under-reporting', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');
    // pathCount is a TOTAL budget in HydraDB and defaults to 1. A budget this
    // small must be reported as truncated rather than passed off as complete.
    const report = await blastRadius(client, leaf!, {
      ...traversal,
      pathCount: 1,
      resultLimit: 1,
    });
    expect(report.truncated).toBe(true);
  });

  it('does not flag truncation when the budget is ample', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');
    const report = await blastRadius(client, leaf!, traversal);
    expect(report.truncated).toBe(false);
  });

  it('checks a named subset of repos in one MSpaths round trip', async () => {
    const leaf = await findVersion(client, 'test:leaf@1.0.0');
    const report = await blastRadiusForRepos(
      client,
      leaf!,
      ['test-org/app-a', 'test-org/app-d'],
      traversal,
    );

    expect(report.procedure).toBe('algo.MSpaths');
    const names = report.exposedRepos.map((exposure) => exposure.repoName);
    expect(names).toContain('app-a');
    expect(names).not.toContain('app-d'); // pins `safe`, not the bad leaf
    expect(names).not.toContain('app-b'); // not asked about
  });

  it('finds nothing for a version no lockfile pins', async () => {
    const safe = await findVersion(client, 'test:safe@1.0.0');
    const report = await blastRadius(client, safe!, traversal);
    expect(report.exposedRepos.map((exposure) => exposure.repoName)).toEqual(['app-d']);
  });
});
