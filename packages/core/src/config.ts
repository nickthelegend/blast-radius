/**
 * Configuration. Every tunable is documented in `.env.example`; this module is
 * the single place that reads the environment, so nothing else has to guess at
 * a default.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Consistency } from './hydra/client.js';

/** Repository root, found by walking up from this file to the package.json
 *  that declares the workspaces. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { workspaces?: unknown };
        if (parsed.workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

let envLoaded = false;

/** Minimal .env reader — avoids a dependency for ~15 lines of parsing. */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = resolve(repoRoot(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function str(key: string, fallback: string): string {
  loadEnv();
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function num(key: string, fallback: number): number {
  const raw = str(key, String(fallback));
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`config: ${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = str(key, fallback ? '1' : '0').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function consistency(key: string, fallback: Consistency): Consistency {
  const raw = str(key, fallback).toLowerCase();
  if (raw !== 'causal' && raw !== 'strong') {
    throw new Error(`config: ${key} must be 'causal' or 'strong', got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * The engine caps any single path at `max_traversal_hops` (16 by default).
 * Blast Radius spends two hops on the trailing `RESOLVED` and `HAS_SNAPSHOT`
 * edges that carry a traversal from a Version out to the owning Repo, so the
 * dependency-depth budget the user configures has to leave room for them.
 */
export const TRAILING_HOPS = 2;
export const ENGINE_MAX_TRAVERSAL_HOPS = 16;

export interface BlastConfig {
  hydra: {
    httpUrl: string;
    boltUrl: string;
    adminUrl: string;
    authToken: string;
    namespace: string;
    graphId: string;
    cellId: string;
    timeoutMs: number;
  };
  traversal: {
    maxDepth: number;
    pathCount: number;
    resultLimit: number;
    readConsistency: Consistency;
    verifiedConsistency: Consistency;
  };
  typosquat: {
    maxDistance: number;
    topN: number;
    minNameLength: number;
    recentDays: number;
    lowDownloadThreshold: number;
    searchSize: number;
  };
  ingest: {
    ecosystems: string[];
    seedCount: number;
    maxDepth: number;
    fullMetadataDepth: number;
    resolveVersionsPerPackage: number;
    advisoryPackageCount: number;
    concurrency: number;
    maxVersionsPerPackage: number;
    npmRegistryUrl: string;
    npmDownloadsApi: string;
    pypiRegistryUrl: string;
    osvApiUrl: string;
    offline: boolean;
  };
  org: {
    name: string;
    repoCount: number;
    snapshotsPerRepo: number;
    randomSeed: number;
    simulatedNow: number;
    directDepsMin: number;
    directDepsMax: number;
    maxLockfileEntries: number;
  };
  server: {
    apiPort: number;
    dashboardPort: number;
  };
  paths: {
    root: string;
    data: string;
    cache: string;
    snapshot: string;
  };
}

export function loadConfig(): BlastConfig {
  loadEnv();
  const root = repoRoot();
  const maxDepth = num('BLAST_MAX_DEPTH', 8);
  const ceiling = ENGINE_MAX_TRAVERSAL_HOPS - TRAILING_HOPS;
  if (maxDepth < 1 || maxDepth > ceiling) {
    throw new Error(
      `config: BLAST_MAX_DEPTH must be between 1 and ${ceiling} ` +
        `(the engine caps total path length at ${ENGINE_MAX_TRAVERSAL_HOPS} hops and Blast Radius ` +
        `spends ${TRAILING_HOPS} of them reaching the owning Repo), got ${maxDepth}`,
    );
  }

  return {
    hydra: {
      httpUrl: str('HYDRA_HTTP_URL', 'http://127.0.0.1:8443'),
      boltUrl: str('HYDRA_BOLT_URL', 'neo4j://127.0.0.1:7687'),
      adminUrl: str('HYDRA_ADMIN_URL', 'http://127.0.0.1:9090'),
      authToken: str('HYDRA_AUTH_TOKEN', 'local-development-token-32-bytes'),
      namespace: str('HYDRA_NAMESPACE', 'default'),
      graphId: str('HYDRA_GRAPH_ID', 'default'),
      cellId: str('HYDRA_CELL_ID', 'cell-0'),
      timeoutMs: num('HYDRA_TIMEOUT_MS', 30_000),
    },
    traversal: {
      maxDepth,
      // HydraDB's `pathCount` is a TOTAL path budget and defaults to 1. Left
      // unset it silently returns a single path, which would under-report a
      // blast radius by orders of magnitude.
      pathCount: num('BLAST_PATH_COUNT', 20_000),
      resultLimit: num('BLAST_RESULT_LIMIT', 20_000),
      readConsistency: consistency('BLAST_READ_CONSISTENCY', 'causal'),
      verifiedConsistency: consistency('BLAST_VERIFIED_CONSISTENCY', 'strong'),
    },
    typosquat: {
      maxDistance: num('TYPOSQUAT_MAX_DISTANCE', 2),
      topN: num('TYPOSQUAT_TOP_N', 150),
      minNameLength: num('TYPOSQUAT_MIN_NAME_LENGTH', 4),
      recentDays: num('TYPOSQUAT_RECENT_DAYS', 90),
      lowDownloadThreshold: num('TYPOSQUAT_LOW_DOWNLOAD_THRESHOLD', 1000),
      searchSize: num('TYPOSQUAT_SEARCH_SIZE', 20),
    },
    ingest: {
      ecosystems: str('INGEST_ECOSYSTEMS', 'npm')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      seedCount: num('INGEST_SEED_COUNT', 300),
      maxDepth: num('INGEST_MAX_DEPTH', 2),
      // Full packuments are the only source of per-version publish times and
      // maintainer lists, but they are enormous (typescript's is 15MB, and it
      // carries every version's README). Abbreviated documents are a fraction
      // of the size and still carry the dependency data the graph is built
      // from, so full documents are fetched for the seeds only — which are
      // exactly the packages the org depends on directly and the ones the
      // Maintainer Web and version timelines are asked about.
      fullMetadataDepth: num('INGEST_FULL_METADATA_DEPTH', 0),
      resolveVersionsPerPackage: num('INGEST_RESOLVE_VERSIONS', 4),
      advisoryPackageCount: num('INGEST_ADVISORY_PACKAGES', 250),
      concurrency: num('INGEST_CONCURRENCY', 12),
      maxVersionsPerPackage: num('INGEST_MAX_VERSIONS_PER_PACKAGE', 12),
      npmRegistryUrl: str('NPM_REGISTRY_URL', 'https://registry.npmjs.org'),
      npmDownloadsApi: str('NPM_DOWNLOADS_API', 'https://api.npmjs.org'),
      pypiRegistryUrl: str('PYPI_REGISTRY_URL', 'https://pypi.org'),
      osvApiUrl: str('OSV_API_URL', 'https://api.osv.dev'),
      offline: bool('BLAST_OFFLINE', false),
    },
    org: {
      name: str('ORG_NAME', 'acme-corp'),
      repoCount: num('ORG_REPO_COUNT', 18),
      snapshotsPerRepo: num('ORG_SNAPSHOTS_PER_REPO', 6),
      randomSeed: num('ORG_RANDOM_SEED', 20260814),
      // The simulated clock the generated lockfile history runs against. Fixed
      // by default so the committed snapshot, the documented example output and
      // the demo scenario all agree.
      simulatedNow: Date.parse(str('ORG_SIMULATED_NOW', '2026-08-14T12:00:00Z')),
      directDepsMin: num('ORG_DIRECT_DEPS_MIN', 4),
      directDepsMax: num('ORG_DIRECT_DEPS_MAX', 12),
      maxLockfileEntries: num('ORG_MAX_LOCKFILE_ENTRIES', 400),
    },
    server: {
      apiPort: num('BLAST_API_PORT', 4000),
      dashboardPort: num('BLAST_DASHBOARD_PORT', 5173),
    },
    paths: {
      root,
      data: resolve(root, 'data'),
      cache: resolve(root, 'data/cache'),
      snapshot: resolve(root, 'data/snapshot'),
    },
  };
}

export function hydraConfigFrom(config: BlastConfig) {
  return {
    httpUrl: config.hydra.httpUrl,
    authToken: config.hydra.authToken,
    namespace: config.hydra.namespace,
    graphId: config.hydra.graphId,
    cellId: config.hydra.cellId,
    timeoutMs: config.hydra.timeoutMs,
    defaultConsistency: config.traversal.readConsistency,
  };
}
