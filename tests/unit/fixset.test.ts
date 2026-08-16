import { describe, expect, it } from 'vitest';

import { minimalFixSet, type RemediationPlan, type RepoFix } from '@blast/core';

/**
 * The greedy set cover behind `remediate --minimal`.
 *
 * The demo dataset happens to produce mostly one-repo-per-change plans, which
 * would let a broken solver pass unnoticed — every greedy choice looks the same
 * when nothing overlaps. These fixtures give it real overlap to resolve.
 */

const fix = (repo: string, pkg: string, target: string | null): RepoFix => ({
  repoKey: `repo:${repo}`,
  repoName: repo,
  depth: 2,
  chainText: `${repo} -> ${pkg}`,
  kind: 'upgrade',
  packageKey: `npm:${pkg}`,
  packageName: pkg,
  currentVersion: '1.0.0',
  targetVersion: target,
  safeVersions: target ? [target] : [],
  isMajorBump: false,
  direction: 'upgrade',
});

const planWith = (fixes: RepoFix[]): RemediationPlan => ({
  source: { key: 'npm:evil@1.0.0' } as RemediationPlan['source'],
  fixes,
  distinctChanges: [],
  reposExposed: fixes.length,
  reposFixable: fixes.filter((f) => f.targetVersion !== null).length,
  elapsedMs: 0,
  candidatesTested: 0,
  cypher: '',
});

describe('minimal fix set', () => {
  it('prefers the change that clears the most repositories', () => {
    const result = minimalFixSet(
      planWith([
        fix('a', 'shared', '2.0.0'),
        fix('b', 'shared', '2.0.0'),
        fix('c', 'shared', '2.0.0'),
        fix('d', 'lonely', '3.0.0'),
      ]),
    );

    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]?.packageName).toBe('shared');
    expect(result.changes[0]?.clears).toEqual(['a', 'b', 'c']);
    expect(result.reposCovered).toBe(4);
  });

  it('never counts a repository twice across two changes', () => {
    // `b` is fixable by either package; whichever is chosen first must consume it.
    const result = minimalFixSet(
      planWith([
        fix('a', 'left', '2.0.0'),
        fix('b', 'left', '2.0.0'),
        fix('b', 'right', '9.9.9'),
        fix('c', 'right', '9.9.9'),
      ]),
    );

    const covered = result.changes.flatMap((change) => change.clears);
    expect(new Set(covered).size).toBe(covered.length);
    expect(result.reposCovered).toBe(new Set(covered).size);
  });

  it('separates repositories no published version can clear', () => {
    const result = minimalFixSet(
      planWith([fix('a', 'shared', '2.0.0'), fix('doomed', 'hopeless', null)]),
    );

    expect(result.unfixable).toEqual(['doomed']);
    expect(result.changes.flatMap((c) => c.clears)).not.toContain('doomed');
  });

  it('is deterministic when two changes cover equally', () => {
    const build = () =>
      minimalFixSet(planWith([fix('a', 'zeta', '2.0.0'), fix('b', 'alpha', '2.0.0')]));

    const first = build();
    const second = build();
    expect(first.changes.map((c) => c.packageName)).toEqual(
      second.changes.map((c) => c.packageName),
    );
    // Ties break lexically, so `alpha` leads regardless of input order.
    expect(first.changes[0]?.packageName).toBe('alpha');
  });

  it('terminates and covers everything fixable on a wide plan', () => {
    const fixes = Array.from({ length: 60 }, (_, index) =>
      fix(`repo-${index}`, `pkg-${index % 7}`, '1.2.3'),
    );
    const result = minimalFixSet(planWith(fixes));

    expect(result.changes).toHaveLength(7);
    expect(result.reposCovered).toBe(60);
  });
});
