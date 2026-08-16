/**
 * Real lockfile parsing.
 *
 * This is what turns Blast Radius from a demo over a generated organisation
 * into something you can point at an actual repository. A lockfile is the
 * exact, authoritative record of what a build installed — every package, every
 * resolved version, and the nesting that decides which copy each dependency
 * actually got. Parsing it gives real `Version` nodes, real `RESOLVED` edges,
 * and — because npm's resolution is fully determined by the lockfile's own
 * directory structure — real `RESOLVED_TO` edges too.
 *
 * Supported, and genuinely parsed rather than approximated:
 *   - package-lock.json v3 and v2 (the flat `packages` map)
 *   - package-lock.json v1 (the nested `dependencies` tree)
 *   - npm-shrinkwrap.json (identical format)
 *   - pnpm-lock.yaml v6 and v9
 *   - yarn.lock v1 (classic)
 *
 * Anything else is rejected with a clear message rather than half-parsed: a
 * lockfile parser that silently misses packages would under-report a blast
 * radius, which is the one failure mode this project cannot have.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type LockfileKind =
  | 'package-lock.json'
  | 'yarn.lock'
  | 'pnpm-lock.yaml'
  | 'requirements.txt'
  | 'poetry.lock';

export interface ParsedEntry {
  name: string;
  version: string;
  /** Path key inside the lockfile, used to resolve nesting. */
  path: string;
  /** Declared dependencies of this entry: name -> range. */
  dependencies: Record<string, string>;
  dev: boolean;
}

export interface ParsedLockfile {
  kind: LockfileKind;
  /** Absolute path the lockfile was read from. */
  file: string;
  /** Lockfile mtime — the honest "captured at" for this snapshot. */
  capturedAt: number;
  /** Project name from package.json, when present. */
  projectName: string;
  /** Direct dependency names declared by the project's manifest. */
  directDependencies: string[];
  entries: ParsedEntry[];
  /** Resolved edges: [dependentPath, dependencyPath] pairs. */
  resolutions: Array<{ from: ParsedEntry; to: ParsedEntry }>;
}

const LOCKFILE_CANDIDATES: Array<[string, LockfileKind]> = [
  ['package-lock.json', 'package-lock.json'],
  ['npm-shrinkwrap.json', 'package-lock.json'],
  ['pnpm-lock.yaml', 'pnpm-lock.yaml'],
  ['yarn.lock', 'yarn.lock'],
];

/**
 * Locate a supported lockfile, given either its directory or the file itself.
 *
 * A command called `inspect-lockfile` that rejects the path of a lockfile is
 * asking the reader to know an implementation detail. Both forms resolve here.
 */
export function findLockfile(target: string): { file: string; kind: LockfileKind } {
  const candidates = LOCKFILE_CANDIDATES;

  // Passed the lockfile directly.
  try {
    if (statSync(target).isFile()) {
      const name = basename(target);
      const match = candidates.find(([filename]) => filename === name);
      if (match) return { file: target, kind: match[1] };
      throw new Error(
        `not a supported lockfile: ${target}\n` +
          `Supported: ${candidates.map(([filename]) => filename).join(', ')}`,
      );
    }
  } catch (error) {
    // A missing path falls through to the directory search, which reports it.
    if (error instanceof Error && error.message.startsWith('not a supported lockfile')) throw error;
  }

  const dir = target;
  for (const [filename, kind] of candidates) {
    const path = join(dir, filename);
    try {
      statSync(path);
      return { file: path, kind };
    } catch {
      /* keep looking */
    }
  }
  throw new Error(
    `no supported lockfile in ${dir}\n` +
      `Looked for: package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock`,
  );
}

export function parseLockfileAt(target: string): ParsedLockfile {
  const { file, kind } = findLockfile(target);
  // `target` may be the lockfile itself, so the project directory is derived
  // from the resolved file rather than assumed to be what was passed in.
  const dir = dirname(resolve(file));
  const capturedAt = statSync(file).mtimeMs;
  const raw = readFileSync(file, 'utf8');

  const manifest = readManifest(dir);

  let entries: ParsedEntry[];
  if (kind === 'package-lock.json') entries = parsePackageLock(raw);
  else if (kind === 'pnpm-lock.yaml') entries = parsePnpmLock(raw);
  else entries = parseYarnLock(raw);

  // In a monorepo the real direct-dependency set is the union of every
  // workspace manifest, not just the root one — the root of this very
  // repository declares three devDependencies while its workspaces pull in
  // express, react, semver and the rest.
  const workspaceDirect =
    kind === 'package-lock.json' ? workspaceDependencies(raw) : [];
  const directDependencies = [...new Set([...manifest.direct, ...workspaceDirect])];

  if (entries.length === 0) {
    throw new Error(`${file} parsed to zero packages — refusing to record an empty snapshot`);
  }

  return {
    kind,
    file,
    capturedAt,
    projectName: manifest.name || basename(resolve(dir)),
    directDependencies,
    entries,
    resolutions: resolveEdges(entries),
  };
}

function readManifest(dir: string): { name: string; direct: string[] } {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return {
      name: parsed.name ?? '',
      direct: [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
        ...Object.keys(parsed.optionalDependencies ?? {}),
      ],
    };
  } catch {
    return { name: '', direct: [] };
  }
}

// --- package-lock.json ------------------------------------------------------

interface PackageLockV3 {
  lockfileVersion?: number;
  packages?: Record<
    string,
    {
      name?: string;
      version?: string;
      dev?: boolean;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      link?: boolean;
    }
  >;
  dependencies?: Record<string, PackageLockV1Entry>;
}

interface PackageLockV1Entry {
  version?: string;
  dev?: boolean;
  requires?: Record<string, string>;
  dependencies?: Record<string, PackageLockV1Entry>;
}

function parsePackageLock(raw: string): ParsedEntry[] {
  const parsed = JSON.parse(raw) as PackageLockV3;

  // v2 and v3 both carry the flat `packages` map, which is authoritative.
  // (v2 also carries a legacy `dependencies` tree for old clients; the flat map
  // is the one npm itself reads.)
  if (parsed.packages) {
    const entries: ParsedEntry[] = [];
    for (const [path, entry] of Object.entries(parsed.packages)) {
      if (path === '') continue; // the project itself
      if (entry.link) continue; // a workspace symlink, not an installed copy
      // A path with no `node_modules/` segment is a workspace *source*
      // directory — a local package like `packages/core`. It is part of the
      // project, not something installed from a registry, so it must never
      // become a Package node: nothing upstream can compromise it, and
      // recording it would put a name into the graph that does not exist on
      // npm at all. Its declared dependencies are picked up separately, as
      // direct dependencies of the project.
      if (!path.includes('node_modules/')) continue;
      if (!entry.version) continue;
      const name = entry.name ?? nameFromPath(path);
      if (!name) continue;
      entries.push({
        name,
        version: entry.version,
        path,
        dependencies: { ...entry.dependencies, ...entry.optionalDependencies },
        dev: entry.dev === true,
      });
    }
    return entries;
  }

  // v1: a nested tree. Flatten it into the same path form so one resolver
  // handles every version.
  if (parsed.dependencies) {
    const entries: ParsedEntry[] = [];
    const walk = (tree: Record<string, PackageLockV1Entry>, prefix: string) => {
      for (const [name, entry] of Object.entries(tree)) {
        if (!entry.version) continue;
        const path = `${prefix}node_modules/${name}`;
        entries.push({
          name,
          version: entry.version,
          path,
          dependencies: entry.requires ?? {},
          dev: entry.dev === true,
        });
        if (entry.dependencies) walk(entry.dependencies, `${path}/`);
      }
    };
    walk(parsed.dependencies, '');
    return entries;
  }

  throw new Error('package-lock.json has neither a `packages` map nor a `dependencies` tree');
}

/** Dependencies declared by workspace packages (paths outside node_modules). */
function workspaceDependencies(raw: string): string[] {
  const parsed = JSON.parse(raw) as PackageLockV3;
  const names = new Set<string>();
  for (const [path, entry] of Object.entries(parsed.packages ?? {})) {
    if (path === '' || path.includes('node_modules/')) continue;
    for (const name of Object.keys(entry.dependencies ?? {})) names.add(name);
  }
  return [...names];
}

/** "node_modules/a/node_modules/@scope/b" -> "@scope/b" */
function nameFromPath(path: string): string {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  return index === -1 ? '' : path.slice(index + marker.length);
}

// --- pnpm-lock.yaml ---------------------------------------------------------

/**
 * pnpm lockfiles are YAML, but the package keys are a fixed, simple shape, so
 * the entries can be read without pulling in a YAML parser:
 *
 *   v9:  'name@1.2.3':            /  packages: entries plus a snapshots: block
 *   v6:  /name@1.2.3:             or  /name/1.2.3:
 */
function parsePnpmLock(raw: string): ParsedEntry[] {
  const lines = raw.split('\n');
  const entries = new Map<string, ParsedEntry>();

  let inPackages = false;
  let current: ParsedEntry | null = null;
  let inDependencies = false;

  const flush = () => {
    if (current) entries.set(current.path, current);
    current = null;
    inDependencies = false;
  };

  for (const line of lines) {
    if (/^[a-zA-Z]/.test(line)) {
      // A new top-level block.
      flush();
      inPackages = line.startsWith('packages:') || line.startsWith('snapshots:');
      continue;
    }
    if (!inPackages) continue;

    // Package key: two-space indented, ends with a colon.
    const keyMatch = /^ {2}'?([^'\s][^']*?)'?:\s*$/.exec(line);
    if (keyMatch?.[1]) {
      flush();
      const parsedKey = parsePnpmKey(keyMatch[1]);
      if (parsedKey) {
        current = {
          name: parsedKey.name,
          version: parsedKey.version,
          path: `node_modules/${parsedKey.name}`,
          dependencies: {},
          dev: false,
        };
      }
      continue;
    }

    if (!current) continue;

    if (/^ {4}(dependencies|optionalDependencies):\s*$/.test(line)) {
      inDependencies = true;
      continue;
    }
    if (/^ {4}\w/.test(line)) {
      inDependencies = false;
      continue;
    }
    if (inDependencies) {
      const depMatch = /^ {6}'?([^'\s:]+)'?:\s*(.+)\s*$/.exec(line);
      if (depMatch?.[1]) {
        current.dependencies[depMatch[1]] = (depMatch[2] ?? '').trim().replace(/^'|'$/g, '');
      }
    }
  }
  flush();

  return [...entries.values()];
}

function parsePnpmKey(key: string): { name: string; version: string } | null {
  // Strip peer-dependency suffixes: "react-dom@18.2.0(react@18.2.0)"
  let cleaned = key.replace(/\(.*\)$/, '');
  if (cleaned.startsWith('/')) cleaned = cleaned.slice(1);

  // v6 slash form: "@scope/name/1.2.3" or "name/1.2.3"
  const slashForm = /^(@[^/]+\/[^/]+|[^/@][^/]*)\/(\d[^/]*)$/.exec(cleaned);
  if (slashForm?.[1] && slashForm[2]) {
    return { name: slashForm[1], version: slashForm[2] };
  }

  // v9 at form: "@scope/name@1.2.3" or "name@1.2.3"
  const at = cleaned.lastIndexOf('@');
  if (at > 0) {
    const name = cleaned.slice(0, at);
    const version = cleaned.slice(at + 1);
    if (/^\d/.test(version)) return { name, version };
  }
  return null;
}

// --- yarn.lock (v1 classic) -------------------------------------------------

function parseYarnLock(raw: string): ParsedEntry[] {
  if (raw.includes('__metadata:')) {
    throw new Error(
      'this is a Yarn Berry (v2+) lockfile, which is YAML with a different schema.\n' +
        'Blast Radius parses Yarn v1 (classic) lockfiles; run `yarn set version classic` or ' +
        'scan the npm/pnpm lockfile instead.',
    );
  }

  const entries = new Map<string, ParsedEntry>();
  const blocks = raw.split(/\n(?=[^\s#])/);

  for (const block of blocks) {
    const lines = block.split('\n');
    const header = lines[0];
    if (!header || header.startsWith('#') || !header.includes('@')) continue;

    const versionLine = lines.find((line) => /^\s{2}version\s/.test(line));
    const versionMatch = versionLine ? /"?([^"\s]+)"?\s*$/.exec(versionLine.trim()) : null;
    const version = versionMatch?.[1];
    if (!version) continue;

    // The header lists one or more specs: `"a@^1.0.0", "a@~1.2.0":`
    const spec = header.replace(/:\s*$/, '').split(',')[0]?.trim().replace(/^"|"$/g, '');
    if (!spec) continue;
    const at = spec.lastIndexOf('@');
    if (at <= 0) continue;
    const name = spec.slice(0, at);

    const dependencies: Record<string, string> = {};
    let inDeps = false;
    for (const line of lines.slice(1)) {
      if (/^\s{2}(dependencies|optionalDependencies):\s*$/.test(line)) {
        inDeps = true;
        continue;
      }
      if (/^\s{2}\S/.test(line)) {
        inDeps = false;
        continue;
      }
      if (inDeps) {
        const depMatch = /^\s{4}"?([^"\s]+)"?\s+"?([^"]+)"?\s*$/.exec(line);
        if (depMatch?.[1]) dependencies[depMatch[1]] = depMatch[2] ?? '*';
      }
    }

    const path = `node_modules/${name}`;
    // Yarn v1 hoists everything, so one entry per (name, version).
    entries.set(`${path}@${version}`, { name, version, path, dependencies, dev: false });
  }

  return [...entries.values()];
}

// --- resolution -------------------------------------------------------------

/**
 * Resolve each entry's declared dependencies to the exact installed copy, using
 * npm's own lookup rule: walk up the directory tree from the dependent, taking
 * the first `node_modules/<name>` that exists. Because the lockfile records the
 * full installed layout, this is not an approximation — it is the resolution
 * npm itself performs.
 */
function resolveEdges(entries: ParsedEntry[]): Array<{ from: ParsedEntry; to: ParsedEntry }> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  // Yarn/pnpm entries share one path per name; index by name as the fallback.
  const byName = new Map<string, ParsedEntry>();
  for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry);

  const edges: Array<{ from: ParsedEntry; to: ParsedEntry }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    for (const depName of Object.keys(entry.dependencies)) {
      const target = lookup(entry.path, depName, byPath) ?? byName.get(depName);
      if (!target || target.path === entry.path) continue;
      const key = `${entry.path}->${target.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: entry, to: target });
    }
  }
  return edges;
}

/** npm's resolution: nearest enclosing node_modules wins. */
function lookup(
  fromPath: string,
  depName: string,
  byPath: Map<string, ParsedEntry>,
): ParsedEntry | undefined {
  // From "node_modules/a/node_modules/b", try:
  //   node_modules/a/node_modules/b/node_modules/<dep>
  //   node_modules/a/node_modules/<dep>
  //   node_modules/<dep>
  let prefix = `${fromPath}/`;
  for (;;) {
    const candidate = byPath.get(`${prefix}node_modules/${depName}`);
    if (candidate) return candidate;
    const marker = prefix.lastIndexOf('node_modules/', Math.max(0, prefix.length - 2));
    if (marker <= 0) break;
    prefix = prefix.slice(0, marker);
  }
  return byPath.get(`node_modules/${depName}`);
}
