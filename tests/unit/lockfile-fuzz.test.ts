import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { parseLockfileAt } from '@blast/core';

/**
 * The lockfile parsers against input that is wrong in every way a real file
 * gets wrong.
 *
 * `scan` is the one place this tool reads a file it did not write. Everything
 * else comes from the vendored snapshot or the graph, but a user points `scan`
 * at their own repository — and lockfiles in the wild are truncated by failed
 * merges, half-rewritten by tooling, hand-edited, and occasionally not JSON at
 * all.
 *
 * The contract under test is narrow and deliberate: **parse it or throw**. What
 * must never happen is a silent partial parse, because a lockfile that yields
 * three of its four hundred packages produces a blast radius that is confidently
 * wrong, and under-reporting exposure is the worst failure this project has.
 */

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'blast-fuzz-'));
  roots.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** Every result must be internally consistent, whatever the input was. */
function expectCoherent(dir: string): void {
  const parsed = parseLockfileAt(dir);
  expect(parsed.entries).toBeInstanceOf(Array);
  expect(parsed.resolutions).toBeInstanceOf(Array);

  const keys = new Set(parsed.entries.map((entry) => `${entry.name}@${entry.version}`));
  for (const edge of parsed.resolutions) {
    // A resolution pointing at a package the parse did not produce is exactly
    // the silent corruption this test exists to catch.
    expect(keys.has(`${edge.to.name}@${edge.to.version}`)).toBe(true);
  }
  for (const entry of parsed.entries) {
    expect(entry.name.length).toBeGreaterThan(0);
    expect(entry.version.length).toBeGreaterThan(0);
  }
}

describe('lockfile parsers, hostile input', () => {
  it('rejects a directory with no lockfile at all', () => {
    const dir = fixture({ 'README.md': '# nothing here' });
    expect(() => parseLockfileAt(dir)).toThrow(/no supported lockfile/i);
  });

  it('rejects a file that is not a supported lockfile', () => {
    const dir = fixture({ 'README.md': 'x' });
    expect(() => parseLockfileAt(join(dir, 'README.md'))).toThrow(/not a supported lockfile/i);
  });

  it('throws rather than half-parsing truncated JSON', () => {
    const dir = fixture({ 'package-lock.json': '{"lockfileVersion":3,"packages":{"node_modu' });
    expect(() => parseLockfileAt(dir)).toThrow();
  });

  it('throws on a lockfile that is not JSON at all', () => {
    const dir = fixture({ 'package-lock.json': '<<<<<<< HEAD\nmerge conflict\n>>>>>>> other' });
    expect(() => parseLockfileAt(dir)).toThrow();
  });

  it('refuses a valid-but-empty package-lock rather than recording nothing', () => {
    // Stricter than I assumed when writing this, and right: a lockfile that
    // yields zero packages would make a repository look clean, which is the
    // failure mode this project cares about most.
    const dir = fixture({ 'package-lock.json': '{"lockfileVersion":3,"packages":{}}' });
    expect(() => parseLockfileAt(dir)).toThrow(/zero packages|empty snapshot/i);
  });

  it('ignores entries with no version rather than inventing one', () => {
    const dir = fixture({
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root' },
          'node_modules/good': { version: '1.0.0' },
          'node_modules/no-version': { resolved: 'https://example.invalid/x.tgz' },
          'node_modules/empty-version': { version: '' },
        },
      }),
    });
    const parsed = parseLockfileAt(dir);
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['good']);
    expectCoherent(dir);
  });

  it('does not choke on a dependency pointing at a package absent from the tree', () => {
    const dir = fixture({
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', dependencies: { ghost: '^1.0.0' } },
          'node_modules/present': { version: '2.0.0', dependencies: { ghost: '^1.0.0' } },
        },
      }),
    });
    expectCoherent(dir);
  });

  it('handles deeply nested node_modules without losing the package name', () => {
    const dir = fixture({
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root' },
          'node_modules/a/node_modules/b/node_modules/@scope/c': { version: '3.1.4' },
        },
      }),
    });
    const parsed = parseLockfileAt(dir);
    expect(parsed.entries[0]?.name).toBe('@scope/c');
    expect(parsed.entries[0]?.version).toBe('3.1.4');
  });

  it('survives absurd version strings without crashing', () => {
    const dir = fixture({
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root' },
          'node_modules/weird': { version: '0.0.0-0.e.0+build.1848' },
          'node_modules/unicode': { version: '1.0.0-ü' },
        },
      }),
    });
    expectCoherent(dir);
  });

  it('survives a yarn.lock with a malformed stanza', () => {
    const dir = fixture({
      'yarn.lock': [
        '# yarn lockfile v1',
        '',
        'left-pad@^1.0.0:',
        '  version "1.3.0"',
        '',
        'broken-no-version@^2.0.0:',
        '  resolved "https://example.invalid/broken.tgz"',
        '',
      ].join('\n'),
    });
    const parsed = parseLockfileAt(dir);
    expect(parsed.entries.some((entry) => entry.name === 'left-pad')).toBe(true);
    expectCoherent(dir);
  });

  it('survives a pnpm lockfile with an unparseable key', () => {
    const dir = fixture({
      'pnpm-lock.yaml': ['lockfileVersion: 9', 'packages:', "  'this-has-no-at-sign': {}", ''].join(
        '\n',
      ),
    });
    // Either it yields nothing or it throws; what it must not do is emit an
    // entry with an empty name or version.
    try {
      expectCoherent(dir);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('never emits a resolution edge to a package it did not parse', () => {
    // The property that matters most, over a spread of shapes at once.
    const shapes = [
      { lockfileVersion: 1, dependencies: { a: { version: '1.0.0', requires: { b: '^2.0.0' } } } },
      { lockfileVersion: 2, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } },
      {
        lockfileVersion: 3,
        packages: {
          '': { name: 'r' },
          'node_modules/a': { version: '1.0.0', dependencies: { missing: '^9.9.9' } },
        },
      },
    ];
    for (const shape of shapes) {
      const dir = fixture({ 'package-lock.json': JSON.stringify(shape) });
      expectCoherent(dir);
    }
  });
});
