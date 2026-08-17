import { describe, expect, it } from 'vitest';

import {
  HydraClient,
  advisoryRadius,
  findPackage,
  hydraConfigFrom,
  loadConfig,
  lockfileDrift,
  maintainerWeb,
} from '@blast/core';

const config = loadConfig();
const client = new HydraClient(hydraConfigFrom(config));

describe('advisory-wide blast radius', () => {
  it('answers for every affected version in one MSpaths call', async () => {
    const report = await advisoryRadius(client, 'GHSA-4x5r-pxfx-6jf8', {
      maxDepth: 8,
      pathCount: 20_000,
      resultLimit: 20_000,
      consistency: 'causal',
    });

    // The point of the feature: an advisory covers a *range*, and this graph
    // holds several versions inside it.
    expect(report.affectedVersions.length).toBeGreaterThan(1);
    expect(report.procedure).toBe('algo.MSpaths');
    expect(report.cypher).toContain('sourceValues');
    // Both tenses, and a repo cannot be in both.
    for (const repo of report.exposedRepos) {
      expect(report.historicalRepos).not.toContain(repo);
    }
  }, 120_000);

  it('refuses an advisory that is not in the graph', async () => {
    await expect(
      advisoryRadius(client, 'GHSA-not-real', {
        maxDepth: 8,
        pathCount: 1000,
        resultLimit: 1000,
        consistency: 'causal',
      }),
    ).rejects.toThrow(/no advisory/i);
  }, 60_000);
});

describe('maintainer depth', () => {
  it('reaches further rings as the depth grows', async () => {
    const pkg = await findPackage(client, 'npm:debug');
    expect(pkg).toBeTruthy();

    const near = await maintainerWeb(client, pkg!, {
      pathCount: 20_000,
      resultLimit: 20_000,
      depth: 2,
    });
    const far = await maintainerWeb(client, pkg!, {
      pathCount: 20_000,
      resultLimit: 20_000,
      depth: 4,
    });

    // A depth control that costs the engine more work and returns the same
    // answer is worse than no control at all — this is the regression guard.
    expect(far.neighbors.length).toBeGreaterThan(near.neighbors.length);
    expect(near.neighbors.every((n) => n.ring === 1)).toBe(true);
    expect(far.neighbors.some((n) => n.ring === 2)).toBe(true);
  }, 180_000);
});

describe('lockfile drift', () => {
  it('ranks repositories by how stale their newest lockfile is', async () => {
    // Injected `now` so the assertion does not depend on when it runs.
    const at = Date.parse('2026-08-17T00:00:00Z');
    const drift = await lockfileDrift(client, { consistency: 'causal', now: at });

    expect(drift.rows.length).toBeGreaterThan(0);
    // Sorted stalest-first.
    const captures = drift.rows.map((row) => row.lastCaptured);
    expect([...captures].sort((a, b) => a - b)).toEqual(captures);
    // "Behind" is relative to the organisation's own median, not a fixed date.
    expect(drift.medianCapture).toBeGreaterThan(0);
    for (const row of drift.rows) {
      expect(row.behind).toBe(row.lastCaptured < drift.medianCapture);
      expect(row.snapshotCount).toBeGreaterThan(0);
    }
  }, 120_000);
});
