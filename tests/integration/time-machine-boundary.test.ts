/**
 * Time Machine window-boundary correctness.
 *
 * The window is inclusive at both ends: a lockfile captured at the exact
 * instant the malicious version went live resolved to it, and so did one
 * captured at the instant it was pulled. These are the cases that decide
 * whether a real incident report is right or off by one build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exposureAsOf, timeMachine } from '../../packages/core/src/queries/timeMachine.js';
import { findVersion } from '../../packages/core/src/queries/lookup.js';
import type { HydraClient } from '../../packages/core/src/index.js';
import {
  WINDOW_FROM,
  WINDOW_TO,
  buildFixture,
  hydraAvailable,
  teardownFixture,
  testClient,
} from './fixture.js';

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

async function leaf() {
  const version = await findVersion(client, 'test:leaf@1.0.0');
  expect(version).not.toBeNull();
  return version!;
}

describe('Time Machine window boundaries', () => {
  it('includes a snapshot captured exactly at the window start', async () => {
    const report = await timeMachine(client, await leaf(), {});
    const captured = report.duringWindow.map((exposure) => exposure.capturedAt);
    expect(captured).toContain(WINDOW_FROM);
  });

  it('includes a snapshot captured exactly at the window end', async () => {
    const report = await timeMachine(client, await leaf(), {});
    const captured = report.duringWindow.map((exposure) => exposure.capturedAt);
    expect(captured).toContain(WINDOW_TO);
  });

  it('excludes a snapshot captured one millisecond before the window', async () => {
    const report = await timeMachine(client, await leaf(), {});
    const captured = report.duringWindow.map((exposure) => exposure.capturedAt);
    expect(captured).not.toContain(WINDOW_FROM - 1);
    // …and it must still be visible as context, not simply dropped.
    expect(report.outsideWindow.map((exposure) => exposure.capturedAt)).toContain(WINDOW_FROM - 1);
  });

  it('excludes a snapshot captured one millisecond after the window', async () => {
    const report = await timeMachine(client, await leaf(), {});
    const captured = report.duringWindow.map((exposure) => exposure.capturedAt);
    expect(captured).not.toContain(WINDOW_TO + 1);
    expect(report.outsideWindow.map((exposure) => exposure.capturedAt)).toContain(WINDOW_TO + 1);
  });

  it('accounts for every snapshot exactly once, in-window or out', async () => {
    const report = await timeMachine(client, await leaf(), {});
    const inside = new Set(report.duringWindow.map((exposure) => exposure.snapshotKey));
    const outside = new Set(report.outsideWindow.map((exposure) => exposure.snapshotKey));
    for (const key of inside) expect(outside.has(key)).toBe(false);
    // The fixture pins the bad leaf from 8 snapshots in total.
    expect(inside.size + outside.size).toBe(8);
  });

  it('separates snapshots that were superseded from those still current', async () => {
    const report = await timeMachine(client, await leaf(), {});
    const stillCurrent = report.stillCurrent.map((exposure) => exposure.repoName);
    const superseded = report.supersededSinceWindow.map((exposure) => exposure.snapshotKey);

    expect(report.duringWindow.length).toBe(
      report.stillCurrent.length + report.supersededSinceWindow.length,
    );
    expect(stillCurrent).toContain('app-a');
    expect(superseded.length).toBeGreaterThan(0);
  });

  it('honours an explicitly overridden window', async () => {
    // A window covering only the first minute must exclude the 09:06 capture.
    const report = await timeMachine(client, await leaf(), {
      from: WINDOW_FROM,
      to: WINDOW_FROM + 60_000,
    });
    const captured = report.duringWindow.map((exposure) => exposure.capturedAt);
    expect(captured).toContain(WINDOW_FROM);
    expect(captured).not.toContain(WINDOW_TO);
  });

  it('rejects an inverted window rather than returning an empty answer', async () => {
    await expect(
      timeMachine(client, await leaf(), { from: WINDOW_TO, to: WINDOW_FROM }),
    ).rejects.toThrow(/ends before it starts/);
  });

  it('refuses to run when no window has been set', async () => {
    const safe = await findVersion(client, 'test:safe@1.0.0');
    await expect(timeMachine(client, safe!, {})).rejects.toThrow(/no compromise window/);
  });

  it('produces identical results under causal and strong consistency', async () => {
    // The graph is quiescent, so the "verified" toggle must not change the
    // answer — only the guarantee behind it.
    const causal = await timeMachine(client, await leaf(), { verified: false });
    const strong = await timeMachine(client, await leaf(), { verified: true });
    expect(strong.consistency).toBe('strong');
    expect(causal.consistency).toBe('causal');
    expect(strong.duringWindow.map((e) => e.snapshotKey).sort()).toEqual(
      causal.duringWindow.map((e) => e.snapshotKey).sort(),
    );
  });
});

describe('point-in-time exposure (exposureAsOf)', () => {
  it('reports a snapshot as of an instant after its capture', async () => {
    const exposures = await exposureAsOf(client, await leaf(), WINDOW_FROM + 90_000);
    const names = exposures.map((exposure) => exposure.repoName);
    expect(names).toContain('app-a'); // captured at +60s, still current
  });

  it('excludes a snapshot that had not been captured yet', async () => {
    const exposures = await exposureAsOf(client, await leaf(), WINDOW_FROM - 10_000);
    const keys = exposures.map((exposure) => exposure.capturedAt);
    for (const captured of keys) expect(captured).toBeLessThanOrEqual(WINDOW_FROM - 10_000);
  });

  it('excludes a snapshot already superseded at that instant', async () => {
    // snapJustBefore is superseded at WINDOW_FROM, so it must not count after.
    const exposures = await exposureAsOf(client, await leaf(), WINDOW_FROM + 1000);
    const captured = exposures.map((exposure) => exposure.capturedAt);
    expect(captured).not.toContain(WINDOW_FROM - 1);
  });
});
