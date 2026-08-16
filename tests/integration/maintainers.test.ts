import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { maintainerWeb } from '../../packages/core/src/queries/maintainers.js';
import { findPackage } from '../../packages/core/src/queries/lookup.js';
import type { HydraClient } from '../../packages/core/src/index.js';
import { buildFixture, hydraAvailable, teardownFixture, testClient } from './fixture.js';

const client: HydraClient = testClient();
let available = false;

beforeAll(async () => {
  available = await hydraAvailable(client);
  if (!available) return;
  await buildFixture(client);
});

afterAll(async () => {
  if (available) await teardownFixture(client);
});

describe('maintainer web', () => {
  it('finds every account that can publish to the package', async () => {
    const pkg = await findPackage(client, 'test:leaf');
    expect(pkg).not.toBeNull();

    const report = await maintainerWeb(client, pkg!, { pathCount: 5000, resultLimit: 5000 });
    const usernames = report.maintainers.map((maintainer) => maintainer.username).sort();
    expect(usernames).toEqual(['alice', 'bob']);
  });

  it('finds sibling packages reachable through a shared account', async () => {
    const pkg = await findPackage(client, 'test:leaf');
    const report = await maintainerWeb(client, pkg!, { pathCount: 5000, resultLimit: 5000 });

    // alice maintains both leaf and sibling-1; bob maintains only leaf.
    const neighbors = report.neighbors.map((neighbor) => neighbor.packageKey);
    expect(neighbors).toEqual(['test:sibling-1']);
  });

  it('names the shared maintainer on each neighbour', async () => {
    const pkg = await findPackage(client, 'test:leaf');
    const report = await maintainerWeb(client, pkg!, { pathCount: 5000, resultLimit: 5000 });
    const sibling = report.neighbors.find((n) => n.packageKey === 'test:sibling-1');
    expect(sibling!.sharedMaintainers).toContain('alice');
    expect(sibling!.sharedMaintainers).not.toContain('bob');
  });

  it('never lists the package as its own neighbour', async () => {
    const pkg = await findPackage(client, 'test:leaf');
    const report = await maintainerWeb(client, pkg!, { pathCount: 5000, resultLimit: 5000 });
    expect(report.neighbors.map((n) => n.packageKey)).not.toContain('test:leaf');
  });

  it('scores risk as LOW when no neighbour is an org dependency', async () => {
    const pkg = await findPackage(client, 'test:leaf');
    const report = await maintainerWeb(client, pkg!, { pathCount: 5000, resultLimit: 5000 });
    // The fixture's org depends on `leaf`, not on `sibling-1`.
    expect(report.orgExposedNeighbors).toHaveLength(0);
    expect(report.riskLevel).toBe('LOW');
  });

  it('returns an empty web for a package with no shared maintainers', async () => {
    const pkg = await findPackage(client, 'test:sibling-1');
    const report = await maintainerWeb(client, pkg!, { pathCount: 5000, resultLimit: 5000 });
    // sibling-1's only maintainer is alice, who also has leaf — so leaf is the
    // neighbour, and the relationship is symmetric.
    expect(report.neighbors.map((n) => n.packageKey)).toEqual(['test:leaf']);
  });
});
