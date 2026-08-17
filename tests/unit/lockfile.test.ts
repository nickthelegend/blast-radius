/**
 * Lockfile parsing.
 *
 * The npm cases run against fixtures written to disk, plus this repository's
 * own real `package-lock.json` — a 281-package v3 lockfile — because a parser
 * verified only against hand-written examples is a parser verified against its
 * author's assumptions.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findLockfile, parseLockfileAt } from '../../packages/core/src/ingest/lockfile.js';

const REPO_ROOT = resolve(__dirname, '../..');

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'blast-lockfile-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

describe('package-lock.json v3', () => {
  const dir = fixture({
    'package.json': JSON.stringify({
      name: 'demo-app',
      dependencies: { alpha: '^1.0.0' },
      devDependencies: { tester: '^2.0.0' },
    }),
    'package-lock.json': JSON.stringify({
      name: 'demo-app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo-app', dependencies: { alpha: '^1.0.0' } },
        'node_modules/alpha': { version: '1.4.0', dependencies: { shared: '^1.0.0' } },
        'node_modules/tester': { version: '2.1.0', dev: true, dependencies: { shared: '^2.0.0' } },
        // tester needs a different major, so npm nests its own copy.
        'node_modules/tester/node_modules/shared': { version: '2.0.1' },
        'node_modules/shared': { version: '1.9.9' },
      },
    }),
  });

  it('reads every installed package', () => {
    const parsed = parseLockfileAt(dir);
    expect(parsed.kind).toBe('package-lock.json');
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.projectName).toBe('demo-app');
  });

  it('reads direct dependencies from package.json, prod and dev', () => {
    const parsed = parseLockfileAt(dir);
    expect(parsed.directDependencies.sort()).toEqual(['alpha', 'tester']);
  });

  it('resolves nesting the way npm does — nearest node_modules wins', () => {
    const parsed = parseLockfileAt(dir);
    const edge = (fromName: string, fromVersion: string) =>
      parsed.resolutions.find(
        (resolution) =>
          resolution.from.name === fromName && resolution.from.version === fromVersion,
      );

    // alpha has no nested copy, so it gets the hoisted shared@1.9.9.
    expect(edge('alpha', '1.4.0')?.to.version).toBe('1.9.9');
    // tester has its own nested copy and must get that one, not the hoisted one.
    expect(edge('tester', '2.1.0')?.to.version).toBe('2.0.1');
  });

  it('records the same package at two versions as two separate entries', () => {
    const parsed = parseLockfileAt(dir);
    const shared = parsed.entries.filter((entry) => entry.name === 'shared');
    expect(shared.map((entry) => entry.version).sort()).toEqual(['1.9.9', '2.0.1']);
  });

  it('skips workspace link entries, which are not installed copies', () => {
    const linked = fixture({
      'package.json': JSON.stringify({ name: 'ws' }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'ws' },
          'packages/inner': { name: 'inner', version: '1.0.0' },
          'node_modules/inner': { resolved: 'packages/inner', link: true },
          'node_modules/real': { version: '3.0.0' },
        },
      }),
    });
    const parsed = parseLockfileAt(linked);
    expect(parsed.entries.map((entry) => entry.name)).not.toContain('inner');
    expect(parsed.entries.map((entry) => entry.name)).toContain('real');
  });
});

describe('package-lock.json v1', () => {
  it('flattens the nested dependencies tree', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'old-app', dependencies: { alpha: '^1.0.0' } }),
      'package-lock.json': JSON.stringify({
        name: 'old-app',
        lockfileVersion: 1,
        dependencies: {
          alpha: {
            version: '1.4.0',
            requires: { shared: '^2.0.0' },
            dependencies: { shared: { version: '2.0.1' } },
          },
          shared: { version: '1.9.9' },
        },
      }),
    });
    const parsed = parseLockfileAt(dir);
    expect(parsed.entries.map((entry) => `${entry.name}@${entry.version}`).sort()).toEqual([
      'alpha@1.4.0',
      'shared@1.9.9',
      'shared@2.0.1',
    ]);
    // alpha's nested copy wins over the hoisted one.
    const edge = parsed.resolutions.find((resolution) => resolution.from.name === 'alpha');
    expect(edge?.to.version).toBe('2.0.1');
  });
});

describe('pnpm-lock.yaml', () => {
  it('parses the v9 name@version key form', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'pnpm-app', dependencies: { alpha: '^1.0.0' } }),
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        '',
        'packages:',
        '',
        '  alpha@1.4.0:',
        '    resolution: {integrity: sha512-aaa}',
        '',
        '  shared@1.9.9:',
        '    resolution: {integrity: sha512-bbb}',
        '',
        'snapshots:',
        '',
        '  alpha@1.4.0:',
        '    dependencies:',
        '      shared: 1.9.9',
        '',
        '  shared@1.9.9: {}',
        '',
      ].join('\n'),
    });
    const parsed = parseLockfileAt(dir);
    expect(parsed.kind).toBe('pnpm-lock.yaml');
    const names = parsed.entries.map((entry) => `${entry.name}@${entry.version}`).sort();
    expect(names).toContain('alpha@1.4.0');
    expect(names).toContain('shared@1.9.9');
  });

  it('parses the v6 slash key form and strips peer suffixes', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'pnpm6' }),
      'pnpm-lock.yaml': [
        "lockfileVersion: '6.0'",
        '',
        'packages:',
        '',
        '  /alpha/1.4.0:',
        '    resolution: {integrity: sha512-aaa}',
        '',
        '  /@scope/thing/2.0.0(react@18.2.0):',
        '    resolution: {integrity: sha512-ccc}',
        '',
      ].join('\n'),
    });
    const parsed = parseLockfileAt(dir);
    const names = parsed.entries.map((entry) => `${entry.name}@${entry.version}`).sort();
    expect(names).toContain('alpha@1.4.0');
    expect(names).toContain('@scope/thing@2.0.0');
  });
});

describe('yarn.lock', () => {
  it('parses the v1 classic format including dependencies', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'yarn-app', dependencies: { alpha: '^1.0.0' } }),
      'yarn.lock': [
        '# THIS IS AN AUTOGENERATED FILE...',
        '',
        'alpha@^1.0.0:',
        '  version "1.4.0"',
        '  resolved "https://registry.yarnpkg.com/alpha/-/alpha-1.4.0.tgz#abc"',
        '  dependencies:',
        '    shared "^1.0.0"',
        '',
        'shared@^1.0.0:',
        '  version "1.9.9"',
        '  resolved "https://registry.yarnpkg.com/shared/-/shared-1.9.9.tgz#def"',
        '',
      ].join('\n'),
    });
    const parsed = parseLockfileAt(dir);
    expect(parsed.kind).toBe('yarn.lock');
    expect(parsed.entries.map((entry) => `${entry.name}@${entry.version}`).sort()).toEqual([
      'alpha@1.4.0',
      'shared@1.9.9',
    ]);
    expect(parsed.resolutions).toHaveLength(1);
    expect(parsed.resolutions[0]!.to.version).toBe('1.9.9');
  });

  it('refuses a Yarn Berry lockfile rather than mis-parsing it', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'berry' }),
      'yarn.lock': ['__metadata:', '  version: 8', '', '"alpha@npm:^1.0.0":', '  version: 1.4.0'].join(
        '\n',
      ),
    });
    expect(() => parseLockfileAt(dir)).toThrow(/Yarn Berry/);
  });
});

describe('error handling', () => {
  it('reports clearly when no lockfile is present', () => {
    const dir = fixture({ 'package.json': '{}' });
    expect(() => findLockfile(dir)).toThrow(/no supported lockfile/);
  });

  it('refuses to record an empty snapshot', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'empty' }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'empty' } } }),
    });
    expect(() => parseLockfileAt(dir)).toThrow(/zero packages/);
  });
});

describe("this repository's own lockfile", () => {
  it('parses the real 281-package v3 lockfile', () => {
    const parsed = parseLockfileAt(REPO_ROOT);
    expect(parsed.kind).toBe('package-lock.json');
    // The published name. This assertion exists because the self-scan reads
    // *this* repository, so a rename that misses the lockfile would silently
    // scan under the wrong project name — which is exactly what it caught.
    expect(parsed.projectName).toBe('@xorv/blast');
    expect(parsed.entries.length).toBeGreaterThan(200);
    expect(parsed.resolutions.length).toBeGreaterThan(200);
  });

  it('finds the real vitest -> debug edge the demo relies on', () => {
    const parsed = parseLockfileAt(REPO_ROOT);
    const vitest = parsed.entries.find((entry) => entry.name === 'vitest');
    expect(vitest).toBeDefined();
    expect(vitest!.dependencies.debug).toBeDefined();

    const edge = parsed.resolutions.find(
      (resolution) => resolution.from.name === 'vitest' && resolution.to.name === 'debug',
    );
    expect(edge).toBeDefined();
    // The range vitest declares must actually be satisfied by what npm installed.
    expect(edge!.to.version.startsWith('4.')).toBe(true);
  });

  it('captures npm installing semver at two different versions', () => {
    const parsed = parseLockfileAt(REPO_ROOT);
    const versions = new Set(
      parsed.entries.filter((entry) => entry.name === 'semver').map((entry) => entry.version),
    );
    expect(versions.size).toBeGreaterThan(1);
  });

  it('reports the lockfile mtime as the capture instant', () => {
    const parsed = parseLockfileAt(REPO_ROOT);
    expect(parsed.capturedAt).toBeGreaterThan(0);
    expect(parsed.capturedAt).toBeLessThanOrEqual(Date.now());
  });
});
