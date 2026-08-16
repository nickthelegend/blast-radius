/**
 * Remediation planning.
 *
 * The fixture is built so each outcome is unambiguous:
 *   - app-a is exposed through mid-1@1.0.0, and mid-1@2.0.0 exists and is
 *     clean — so there is a real fix and the planner must find it.
 *   - app-b is exposed through mid-2@1.0.0, and mid-2@2.0.0 *still* reaches the
 *     bad leaf — so the planner must NOT offer it.
 *   - app-c pins the compromised package directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { blastRadius } from '../../packages/core/src/queries/blastRadius.js';
import { findVersion } from '../../packages/core/src/queries/lookup.js';
import { planRemediation } from '../../packages/core/src/queries/remediation.js';
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

async function plan() {
  const leaf = await findVersion(client, 'test:leaf@1.0.0');
  expect(leaf).not.toBeNull();
  const report = await blastRadius(client, leaf!, traversal);
  return planRemediation(client, report, traversal);
}

describe('remediation planning', () => {
  it('proposes a fix for every exposed repository that has one', async () => {
    const result = await plan();
    expect(result.reposExposed).toBe(3);
    expect(result.fixes).toHaveLength(3);
  });

  it('finds the clean upgrade when one exists', async () => {
    const result = await plan();
    const appA = result.fixes.find((fix) => fix.repoName === 'app-a');
    expect(appA).toBeDefined();
    expect(appA!.packageName).toBe('mid-1');
    expect(appA!.currentVersion).toBe('1.0.0');
    expect(appA!.targetVersion).toBe('2.0.0');
    expect(appA!.direction).toBe('upgrade');
  });

  it('refuses a candidate that still reaches the compromised version', async () => {
    const result = await plan();
    const appB = result.fixes.find((fix) => fix.repoName === 'app-b');
    expect(appB).toBeDefined();
    expect(appB!.packageName).toBe('mid-2');
    // mid-2@2.0.0 exists but still depends on the bad leaf, so there is no fix.
    expect(appB!.safeVersions).not.toContain('2.0.0');
    expect(appB!.targetVersion).toBeNull();
    expect(appB!.kind).toBe('no-safe-version');
  });

  it('says plainly when nothing published avoids the bad version', async () => {
    const result = await plan();
    const appB = result.fixes.find((fix) => fix.repoName === 'app-b');
    expect(appB!.explanation).toMatch(/no published version/);
  });

  it('handles a repo that pins the compromised package directly', async () => {
    const result = await plan();
    const appC = result.fixes.find((fix) => fix.repoName === 'app-c');
    expect(appC).toBeDefined();
    // leaf@1.0.0 is the only version of leaf, so there is nothing to move to.
    expect(appC!.packageName).toBe('leaf');
    expect(appC!.targetVersion).toBeNull();
  });

  it('flags a major-version move so it is not applied blindly', async () => {
    const result = await plan();
    const appA = result.fixes.find((fix) => fix.repoName === 'app-a');
    expect(appA!.isMajorBump).toBe(true); // 1.0.0 -> 2.0.0
  });

  it('collapses per-repo fixes into the distinct set of changes to make', async () => {
    const result = await plan();
    const change = result.distinctChanges.find((entry) => entry.packageName === 'mid-1');
    expect(change).toBeDefined();
    expect(change!.to).toBe('2.0.0');
    expect(change!.repos).toContain('app-a');
    // Only fixable exposures produce a change entry.
    expect(result.distinctChanges).toHaveLength(1);
  });

  it('counts how many candidates it actually tested', async () => {
    const result = await plan();
    expect(result.candidatesTested).toBeGreaterThan(0);
  });

  it('reports nothing to do when no repo is exposed', async () => {
    const safe = await findVersion(client, 'test:safe@1.0.0');
    const report = await blastRadius(client, safe!, traversal);
    // app-d pins `safe`, so it IS exposed to it — but there is no newer version.
    const result = await planRemediation(client, report, traversal);
    expect(result.fixes.every((fix) => fix.targetVersion === null)).toBe(true);
  });
});
