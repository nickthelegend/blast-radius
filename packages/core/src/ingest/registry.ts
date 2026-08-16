/**
 * Registry access: npm, PyPI and OSV.dev.
 *
 * Every response is cached to `data/cache/` keyed by URL, so a re-run costs
 * nothing and `BLAST_OFFLINE=1` can replay an ingest with no network at all.
 * Packuments are *reduced* before caching — a full npm packument carries the
 * README and every version's complete manifest, which is tens of megabytes
 * across a few thousand packages and none of it is used here.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ReducedVersion {
  version: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  publishedAt: number;
  deprecated: boolean;
}

export interface ReducedPackument {
  name: string;
  latest: string;
  createdAt: number;
  modifiedAt: number;
  maintainers: Array<{ username: string; emailHash: string }>;
  versions: ReducedVersion[];
}

export interface OsvRange {
  introduced: string;
  fixed: string | null;
}

export interface OsvAdvisory {
  id: string;
  summary: string;
  published: number;
  severity: string;
  ranges: OsvRange[];
  affectedVersions: string[];
}

export class RegistryClient {
  private inflight = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly options: {
      cacheDir: string;
      concurrency: number;
      offline: boolean;
      npmRegistryUrl: string;
      npmDownloadsApi: string;
      pypiRegistryUrl: string;
      osvApiUrl: string;
      maxVersionsPerPackage: number;
    },
  ) {
    mkdirSync(options.cacheDir, { recursive: true });
  }

  private cachePath(kind: string, key: string): string {
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 40);
    const dir = join(this.options.cacheDir, kind);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${digest}.json`);
  }

  private readCache<T>(kind: string, key: string): T | null {
    const path = this.cachePath(kind, key);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private writeCache(kind: string, key: string, value: unknown): void {
    writeFileSync(this.cachePath(kind, key), JSON.stringify(value));
  }

  /** Simple concurrency gate — keeps the registry happy and the run bounded. */
  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.inflight >= this.options.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inflight += 1;
    try {
      return await run();
    } finally {
      this.inflight -= 1;
      this.queue.shift()?.();
    }
  }

  private async fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    if (this.options.offline) {
      throw new Error(`offline mode: refusing to fetch ${url}`);
    }
    return this.withSlot(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, {
            headers: { 'User-Agent': 'blast-radius/1.0 (hackathon project)', ...headers },
            signal: AbortSignal.timeout(30_000),
          });
          if (response.status === 404) return null;
          if (response.status === 429 || response.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            continue;
          }
          if (!response.ok) throw new Error(`${response.status} for ${url}`);
          return await response.json();
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
      throw lastError ?? new Error(`failed to fetch ${url}`);
    });
  }

  /**
   * npm packument, reduced.
   *
   * `full` fetches the complete document, which is the only place per-version
   * publish timestamps and maintainer lists live. The abbreviated document
   * (`application/vnd.npm.install-v1+json`) is far smaller but carries neither,
   * so it is used for the deep transitive tail where only dependency edges
   * matter.
   */
  async npmPackument(name: string, full: boolean): Promise<ReducedPackument | null> {
    const cacheKey = `${name}:${full ? 'full' : 'abbrev'}`;
    const cached = this.readCache<ReducedPackument | { missing: true }>('npm', cacheKey);
    if (cached) return 'missing' in cached ? null : cached;

    const url = `${this.options.npmRegistryUrl}/${name.replace(/\//g, '%2f')}`;
    const raw = (await this.fetchJson(
      url,
      full ? {} : { Accept: 'application/vnd.npm.install-v1+json' },
    )) as RawPackument | null;

    if (!raw || !raw.versions) {
      this.writeCache('npm', cacheKey, { missing: true });
      return null;
    }

    const reduced = reducePackument(raw, this.options.maxVersionsPerPackage);
    this.writeCache('npm', cacheKey, reduced);
    return reduced;
  }

  /** Weekly download counts, batched (the bulk endpoint takes up to 128). */
  async npmDownloads(names: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    // Scoped packages are rejected by the bulk endpoint, so they go one by one.
    const unscoped = names.filter((name) => !name.startsWith('@'));
    const scoped = names.filter((name) => name.startsWith('@'));

    for (let offset = 0; offset < unscoped.length; offset += 100) {
      const chunk = unscoped.slice(offset, offset + 100);
      const key = chunk.join(',');
      const cached = this.readCache<Record<string, number>>('downloads', key);
      if (cached) {
        for (const [name, value] of Object.entries(cached)) out.set(name, value);
        continue;
      }
      try {
        const raw = (await this.fetchJson(
          `${this.options.npmDownloadsApi}/downloads/point/last-week/${key}`,
        )) as Record<string, { downloads?: number } | null> | null;
        const resolved: Record<string, number> = {};
        if (raw) {
          for (const [name, value] of Object.entries(raw)) {
            resolved[name] = value?.downloads ?? 0;
          }
        }
        this.writeCache('downloads', key, resolved);
        for (const [name, value] of Object.entries(resolved)) out.set(name, value);
      } catch {
        for (const name of chunk) out.set(name, 0);
      }
    }

    for (const name of scoped) {
      const cached = this.readCache<{ downloads: number }>('downloads', name);
      if (cached) {
        out.set(name, cached.downloads);
        continue;
      }
      try {
        const raw = (await this.fetchJson(
          `${this.options.npmDownloadsApi}/downloads/point/last-week/${name.replace(/\//g, '%2f')}`,
        )) as { downloads?: number } | null;
        const downloads = raw?.downloads ?? 0;
        this.writeCache('downloads', name, { downloads });
        out.set(name, downloads);
      } catch {
        out.set(name, 0);
      }
    }

    return out;
  }

  /**
   * npm registry search, used to find real packages whose names sit close to
   * the org's dependencies.
   *
   * The dependency crawl only ever reaches packages that popular packages
   * actually depend on — i.e. legitimate ones. A typosquat is by construction
   * *not* in anybody's dependency tree, so without this the proximity check has
   * nothing real to evaluate and reports only false positives.
   */
  async npmSearch(text: string, size = 20): Promise<Array<{ name: string; date: number }>> {
    const cacheKey = `${text}:${size}`;
    const cached = this.readCache<Array<{ name: string; date: number }>>('search', cacheKey);
    if (cached) return cached;

    let results: Array<{ name: string; date: number }> = [];
    try {
      const raw = (await this.fetchJson(
        `${this.options.npmRegistryUrl}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`,
      )) as { objects?: Array<{ package?: { name?: string; date?: string } }> } | null;
      results = (raw?.objects ?? [])
        .map((entry) => ({
          name: entry.package?.name ?? '',
          date: entry.package?.date ? Date.parse(entry.package.date) : 0,
        }))
        .filter((entry) => entry.name !== '');
    } catch {
      results = [];
    }

    this.writeCache('search', cacheKey, results);
    return results;
  }

  /** Real advisories from OSV.dev for one package. */
  async osvAdvisories(ecosystem: string, name: string): Promise<OsvAdvisory[]> {
    const cacheKey = `${ecosystem}:${name}`;
    const cached = this.readCache<OsvAdvisory[]>('osv', cacheKey);
    if (cached) return cached;

    const ecosystemName = ecosystem === 'pypi' ? 'PyPI' : 'npm';
    let advisories: OsvAdvisory[] = [];
    try {
      const response = await this.withSlot(async () => {
        if (this.options.offline) throw new Error('offline');
        const result = await fetch(`${this.options.osvApiUrl}/v1/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ package: { name, ecosystem: ecosystemName } }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!result.ok) return null;
        return (await result.json()) as RawOsvResponse;
      });
      advisories = reduceOsv(response, name);
    } catch {
      advisories = [];
    }

    this.writeCache('osv', cacheKey, advisories);
    return advisories;
  }

  /** PyPI project metadata, reduced to the same shape as an npm packument. */
  async pypiProject(name: string): Promise<ReducedPackument | null> {
    const cached = this.readCache<ReducedPackument | { missing: true }>('pypi', name);
    if (cached) return 'missing' in cached ? null : cached;

    const raw = (await this.fetchJson(`${this.options.pypiRegistryUrl}/pypi/${name}/json`)) as
      | RawPypiProject
      | null;
    if (!raw?.releases) {
      this.writeCache('pypi', name, { missing: true });
      return null;
    }

    const versions: ReducedVersion[] = [];
    for (const [version, files] of Object.entries(raw.releases)) {
      const uploaded = files?.[0]?.upload_time_iso_8601;
      versions.push({
        version,
        dependencies: {},
        peerDependencies: {},
        optionalDependencies: {},
        publishedAt: uploaded ? Date.parse(uploaded) : 0,
        deprecated: files?.[0]?.yanked === true,
      });
    }
    versions.sort((a, b) => b.publishedAt - a.publishedAt);

    // requires_dist looks like "requests (>=2.0) ; extra == 'security'".
    const requires = raw.info?.requires_dist ?? [];
    const dependencies: Record<string, string> = {};
    for (const entry of requires) {
      if (!entry || entry.includes('extra ==')) continue;
      const match = /^([A-Za-z0-9._-]+)\s*(?:\(([^)]*)\))?/.exec(entry.trim());
      if (match?.[1]) dependencies[match[1].toLowerCase()] = match[2]?.trim() || '*';
    }
    const kept = versions.slice(0, this.options.maxVersionsPerPackage);
    for (const version of kept) version.dependencies = dependencies;

    const author = raw.info?.author ?? raw.info?.author_email ?? '';
    const reduced: ReducedPackument = {
      name,
      latest: raw.info?.version ?? kept[0]?.version ?? '',
      createdAt: versions.length ? Math.min(...versions.map((v) => v.publishedAt || Infinity)) : 0,
      modifiedAt: versions[0]?.publishedAt ?? 0,
      maintainers: author ? [parsePypiAuthor(String(author))] : [],
      versions: kept,
    };
    this.writeCache('pypi', name, reduced);
    return reduced;
  }
}

// --- raw shapes -------------------------------------------------------------

interface RawPackument {
  name?: string;
  time?: Record<string, string>;
  'dist-tags'?: { latest?: string };
  maintainers?: Array<{ name?: string; email?: string }>;
  versions?: Record<
    string,
    {
      version?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      deprecated?: unknown;
    }
  >;
}

interface RawOsvResponse {
  vulns?: Array<{
    id?: string;
    summary?: string;
    details?: string;
    published?: string;
    severity?: Array<{ type?: string; score?: string }>;
    database_specific?: { severity?: string };
    affected?: Array<{
      package?: { name?: string };
      versions?: string[];
      ranges?: Array<{ type?: string; events?: Array<{ introduced?: string; fixed?: string }> }>;
    }>;
  }>;
}

interface RawPypiProject {
  info?: { version?: string; requires_dist?: string[]; author?: string; author_email?: string };
  releases?: Record<string, Array<{ upload_time_iso_8601?: string; yanked?: boolean }> | undefined>;
}

/**
 * PyPI puts the author in one free-text field, in any of several shapes:
 *   "Kenneth Reitz"
 *   "Kenneth Reitz <me@example.org>"
 *   "me@example.org"
 * Splitting naively on "@" turns the second form into "Kenneth Reitz <me",
 * so the name and the address are separated properly and only the address is
 * hashed.
 */
export function parsePypiAuthor(value: string): { username: string; emailHash: string } {
  const trimmed = value.trim();
  const angled = /^(.*?)\s*<([^>]+)>\s*$/.exec(trimmed);
  if (angled) {
    const name = (angled[1] ?? '').trim();
    const email = (angled[2] ?? '').trim();
    return {
      username: name || (email.split('@')[0] ?? 'unknown'),
      emailHash: hashEmail(email),
    };
  }
  if (trimmed.includes('@')) {
    return { username: trimmed.split('@')[0] ?? 'unknown', emailHash: hashEmail(trimmed) };
  }
  return { username: trimmed || 'unknown', emailHash: '' };
}

/** Registry emails are public, but they are still PII. Only a truncated digest
 *  is retained so the graph never carries a raw address. */
export function hashEmail(email: string): string {
  if (!email) return '';
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function reducePackument(raw: RawPackument, maxVersions: number): ReducedPackument {
  const time = raw.time ?? {};
  const all = Object.entries(raw.versions ?? {}).map(([version, manifest]) => ({
    version,
    dependencies: manifest?.dependencies ?? {},
    peerDependencies: manifest?.peerDependencies ?? {},
    optionalDependencies: manifest?.optionalDependencies ?? {},
    publishedAt: time[version] ? Date.parse(time[version]!) : 0,
    deprecated: Boolean(manifest?.deprecated),
  }));

  // Newest first, then truncated: a package with 900 published versions would
  // otherwise dominate the graph without adding any structural information.
  all.sort((a, b) => b.publishedAt - a.publishedAt || compareVersionStrings(b.version, a.version));
  const latest = raw['dist-tags']?.latest ?? all[0]?.version ?? '';
  const kept = all.slice(0, maxVersions);
  // The latest version must survive truncation — it anchors resolution.
  if (latest && !kept.some((entry) => entry.version === latest)) {
    const found = all.find((entry) => entry.version === latest);
    if (found) kept.unshift(found);
  }

  return {
    name: raw.name ?? '',
    latest,
    createdAt: time.created ? Date.parse(time.created) : 0,
    modifiedAt: time.modified ? Date.parse(time.modified) : 0,
    maintainers: (raw.maintainers ?? [])
      .filter((maintainer) => maintainer?.name)
      .map((maintainer) => ({
        username: maintainer.name!,
        emailHash: hashEmail(maintainer.email ?? ''),
      })),
    versions: kept,
  };
}

/** Rough numeric-aware comparison, only used as a tiebreak when publish
 *  timestamps are missing. */
function compareVersionStrings(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  }
  return a.localeCompare(b);
}

function reduceOsv(raw: RawOsvResponse | null, packageName: string): OsvAdvisory[] {
  if (!raw?.vulns) return [];
  const advisories: OsvAdvisory[] = [];

  for (const vuln of raw.vulns) {
    if (!vuln.id) continue;
    const affected = (vuln.affected ?? []).filter(
      (entry) => !entry.package?.name || entry.package.name === packageName,
    );
    const ranges: OsvRange[] = [];
    const versions = new Set<string>();

    for (const entry of affected) {
      for (const version of entry.versions ?? []) versions.add(version);
      for (const range of entry.ranges ?? []) {
        if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue;
        let introduced: string | null = null;
        for (const event of range.events ?? []) {
          if (event.introduced !== undefined) introduced = event.introduced;
          if (event.fixed !== undefined) {
            ranges.push({ introduced: introduced ?? '0.0.0', fixed: event.fixed });
            introduced = null;
          }
        }
        if (introduced !== null) ranges.push({ introduced, fixed: null });
      }
    }

    advisories.push({
      id: vuln.id,
      summary: vuln.summary ?? vuln.details?.slice(0, 200) ?? '',
      published: vuln.published ? Date.parse(vuln.published) : 0,
      severity: vuln.database_specific?.severity ?? vuln.severity?.[0]?.score ?? 'UNKNOWN',
      ranges,
      affectedVersions: [...versions],
    });
  }

  return advisories;
}
