import { describe, expect, it } from 'vitest';

import { levenshtein, proximity } from '../../packages/core/src/typosquat/distance.js';
import { computeSimilarityEdges } from '../../packages/core/src/queries/typosquats.js';
import type { PackageNode } from '../../packages/core/src/model/types.js';

describe('levenshtein', () => {
  it('measures edit distance', () => {
    expect(levenshtein('left-pad', 'left-pad')).toBe(0);
    expect(levenshtein('left-pad', '1eft-pad')).toBe(1);
    expect(levenshtein('express', 'expres')).toBe(1);
    expect(levenshtein('lodash', 'lodahs')).toBe(2);
  });

  it('exits early past the cap rather than computing the true distance', () => {
    // The contract is only "greater than max", which is all the caller needs.
    expect(levenshtein('abcdefgh', 'zyxwvuts', 2)).toBeGreaterThan(2);
    expect(levenshtein('short', 'a-very-much-longer-name', 2)).toBeGreaterThan(2);
  });
});

describe('proximity thresholds', () => {
  it('ignores identical names', () => {
    expect(proximity('left-pad', 'left-pad', 2)).toBeNull();
  });

  it('rejects anything beyond the configured distance', () => {
    expect(proximity('completely-different', 'left-pad', 2)).toBeNull();
  });

  it('flags a digit-for-letter homoglyph as high risk', () => {
    const result = proximity('1eft-pad', 'left-pad', 2);
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(1);
    expect(result!.score).toBeGreaterThanOrEqual(0.9);
    expect(result!.reason).toContain('confusable');
  });

  it('flags an adjacent-key substitution', () => {
    const result = proximity('lodasg', 'lodash', 2);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('adjacent-key');
  });

  it('flags punctuation variants, the classic squat pattern', () => {
    const result = proximity('performancenow', 'performance-now', 2);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('punctuation');
  });

  it('treats the same bare name under a different scope as dependency confusion', () => {
    const result = proximity('@attacker/graceful-fs', 'graceful-fs', 2);
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(0);
    expect(result!.reason).toContain('dependency confusion');
  });

  it('does NOT flag two different public scopes sharing a suffix', () => {
    // @babel/core vs @jest/core is the single largest source of false
    // positives: unscoping leaves "core" == "core".
    expect(proximity('@jest/core', '@babel/core', 2)).toBeNull();
    expect(proximity('@eslint/core', '@babel/core', 2)).toBeNull();
  });

  it('does NOT flag distant matches between short unscoped names', () => {
    // "jose" vs "core" is two edits purely because both are four letters.
    expect(proximity('@depup/jose', '@babel/core', 2)).toBeNull();
  });

  it('requires a scope on exactly one side for the confusion rule', () => {
    expect(proximity('@a/utilities', '@b/utilities', 2)).not.toBeNull();
    expect(proximity('@a/util', 'util', 2)).toBeNull(); // bare name too short
  });
});

describe('computeSimilarityEdges', () => {
  const pkg = (name: string, downloads = 0): PackageNode => ({
    key: `npm:${name}`,
    name,
    ecosystem: 'npm',
    downloads,
    created_at: 0,
    dependent_count: 0,
  });

  it('only compares against the trusted set, and never a package with itself', () => {
    const trusted = [pkg('left-pad', 1_000_000)];
    const candidates = [pkg('left-pad', 1_000_000), pkg('1eft-pad'), pkg('unrelated-thing')];
    const edges = computeSimilarityEdges(trusted, candidates, {
      maxDistance: 2,
      minNameLength: 4,
    });
    expect(edges.map((edge) => edge.to_package_key)).toEqual(['npm:1eft-pad']);
    expect(edges[0]!.from_package_key).toBe('npm:left-pad');
  });

  it('skips names shorter than the configured minimum', () => {
    const edges = computeSimilarityEdges([pkg('ms')], [pkg('rns')], {
      maxDistance: 2,
      minNameLength: 4,
    });
    expect(edges).toHaveLength(0);
  });

  it('respects the distance threshold', () => {
    const trusted = [pkg('graceful-fs')];
    const candidates = [pkg('graceful-fz'), pkg('gracefull-fs')];
    expect(
      computeSimilarityEdges(trusted, candidates, { maxDistance: 1, minNameLength: 4 }).length,
    ).toBe(2);
    expect(
      computeSimilarityEdges(trusted, [pkg('totally-elsewhere')], {
        maxDistance: 1,
        minNameLength: 4,
      }).length,
    ).toBe(0);
  });

  it('orders findings by score, strongest signal first', () => {
    const edges = computeSimilarityEdges(
      [pkg('performance-now')],
      [pkg('performancenow'), pkg('performance-noe')],
      { maxDistance: 2, minNameLength: 4 },
    );
    expect(edges.length).toBeGreaterThan(1);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i - 1]!.score).toBeGreaterThanOrEqual(edges[i]!.score);
    }
  });
});
