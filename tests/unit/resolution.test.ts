import { describe, expect, it } from 'vitest';

import { isAffected, resolveRange } from '../../packages/core/src/ingest/build.js';
import { buildVersionTimeline } from '../../packages/core/src/queries/blastRadius.js';
import { mulberry32 } from '../../packages/core/src/ingest/org.js';
import { parsePackageKey, parseVersionKey } from '../../packages/core/src/model/types.js';
import type { VersionRef } from '../../packages/core/src/queries/lookup.js';

describe('resolveRange', () => {
  const available = ['1.0.0', '1.2.0', '1.9.3', '2.0.0', '2.1.4'];

  it('picks the highest version satisfying a caret range', () => {
    expect(resolveRange('^1.0.0', available)).toBe('1.9.3');
    expect(resolveRange('^2.0.0', available)).toBe('2.1.4');
  });

  it('honours exact pins and tilde ranges', () => {
    expect(resolveRange('1.2.0', available)).toBe('1.2.0');
    expect(resolveRange('~1.2.0', available)).toBe('1.2.0');
  });

  it('returns null when nothing satisfies the range', () => {
    expect(resolveRange('^9.0.0', available)).toBeNull();
  });

  it('falls back to the newest version for wildcards and tags', () => {
    expect(resolveRange('*', available)).toBe('2.1.4');
    expect(resolveRange('latest', available)).toBe('2.1.4');
    // npm accepts ranges semver cannot parse (git urls, aliases); the crawl
    // must not drop the edge entirely because of one.
    expect(resolveRange('github:foo/bar', available)).toBe('2.1.4');
  });

  it('handles an empty version list', () => {
    expect(resolveRange('^1.0.0', [])).toBeNull();
  });
});

describe('isAffected — OSV half-open [introduced, fixed) ranges', () => {
  const ranges = [{ introduced: '4.0.0', fixed: '4.17.21' }];

  it('includes the introduced version', () => {
    expect(isAffected('4.0.0', ranges, [])).toBe(true);
  });

  it('excludes the fixed version', () => {
    expect(isAffected('4.17.21', ranges, [])).toBe(false);
  });

  it('includes versions inside the range', () => {
    expect(isAffected('4.17.20', ranges, [])).toBe(true);
  });

  it('excludes versions before the range', () => {
    expect(isAffected('3.10.1', ranges, [])).toBe(false);
  });

  it('treats an unfixed range as open-ended', () => {
    expect(isAffected('9.9.9', [{ introduced: '1.0.0', fixed: null }], [])).toBe(true);
  });

  it('honours explicitly enumerated versions', () => {
    expect(isAffected('0.0.1-weird', [], ['0.0.1-weird'])).toBe(true);
  });
});

describe('key parsing', () => {
  it('splits an unscoped version key', () => {
    expect(parseVersionKey('npm:left-pad@3.4.1')).toEqual({
      ecosystem: 'npm',
      name: 'left-pad',
      version: '3.4.1',
    });
  });

  it('splits a scoped version key on the LAST @', () => {
    expect(parseVersionKey('npm:@babel/core@7.24.0')).toEqual({
      ecosystem: 'npm',
      name: '@babel/core',
      version: '7.24.0',
    });
  });

  it('splits package keys', () => {
    expect(parsePackageKey('npm:@types/node')).toEqual({
      ecosystem: 'npm',
      name: '@types/node',
    });
  });

  it('rejects malformed keys rather than guessing', () => {
    expect(() => parseVersionKey('no-ecosystem@1.0.0')).toThrow();
    expect(() => parseVersionKey('npm:no-version')).toThrow();
  });
});

describe('buildVersionTimeline — "which version introduced the vulnerability"', () => {
  const version = (v: string, publishedAt: number, advisoryId = ''): VersionRef => ({
    id: 0,
    key: `npm:pkg@${v}`,
    packageKey: 'npm:pkg',
    packageName: 'pkg',
    versionString: v,
    ecosystem: 'npm',
    publishedAt,
    isCompromised: false,
    compromisedFrom: 0,
    compromisedTo: 0,
    advisoryId,
  });

  it('marks only the first affected publish as the point of introduction', () => {
    const timeline = buildVersionTimeline([
      version('1.2.0', 3000, 'GHSA-x'),
      version('1.0.0', 1000),
      version('1.1.0', 2000, 'GHSA-x'),
      version('1.3.0', 4000),
    ]);

    expect(timeline.map((entry) => entry.versionString)).toEqual([
      '1.0.0',
      '1.1.0',
      '1.2.0',
      '1.3.0',
    ]);
    expect(timeline.filter((entry) => entry.introducesVulnerability)).toHaveLength(1);
    expect(timeline.find((entry) => entry.introducesVulnerability)!.versionString).toBe('1.1.0');
  });

  it('reports no introduction point when nothing is affected', () => {
    const timeline = buildVersionTimeline([version('1.0.0', 1000), version('1.1.0', 2000)]);
    expect(timeline.some((entry) => entry.introducesVulnerability)).toBe(false);
  });
});

describe('mulberry32 — deterministic org generation', () => {
  it('produces the same stream for the same seed', () => {
    const a = mulberry32(20260814);
    const b = mulberry32(20260814);
    const first = Array.from({ length: 20 }, () => a());
    const second = Array.from({ length: 20 }, () => b());
    expect(first).toEqual(second);
  });

  it('produces a different stream for a different seed', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 10 }, () => a())).not.toEqual(
      Array.from({ length: 10 }, () => b()),
    );
  });

  it('stays inside [0, 1)', () => {
    const random = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
