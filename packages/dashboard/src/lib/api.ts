/** Typed wrappers over the Blast Radius API. */

export interface VersionRef {
  id: number;
  key: string;
  packageKey: string;
  packageName: string;
  versionString: string;
  publishedAt: number;
  isCompromised: boolean;
  compromisedFrom: number;
  compromisedTo: number;
  advisoryId: string;
}

export interface ChainLink {
  kind: 'version' | 'snapshot' | 'repo';
  label: string;
  key: string;
}

export interface ExposedRepo {
  repoKey: string;
  repoName: string;
  depth: number;
  chain: ChainLink[];
  chainText: string;
  snapshotKey: string;
  snapshotCapturedAt: number;
  viaCurrentLockfile: boolean;
  direct: boolean;
}

export interface BlastRadiusReport {
  source: VersionRef;
  exposedRepos: ExposedRepo[];
  historicallyExposedRepos: ExposedRepo[];
  exposedPackages: Array<{
    versionKey: string;
    packageName: string;
    versionString: string;
    depth: number;
  }>;
  totalPaths: number;
  maxDepthUsed: number;
  pathCountUsed: number;
  truncated: boolean;
  elapsedMs: number;
  consistency: string;
  procedure: string;
  cypher: string;
}

export interface SnapshotExposure {
  snapshotKey: string;
  repoKey: string;
  repoName: string;
  capturedAt: number;
  supersededAt: number;
  isCurrent: boolean;
  source: string;
  commitSha: string;
  direct: boolean;
}

export interface TimeMachineReport {
  version: VersionRef;
  windowFrom: number;
  windowTo: number;
  duringWindow: SnapshotExposure[];
  supersededSinceWindow: SnapshotExposure[];
  stillCurrent: SnapshotExposure[];
  outsideWindow: SnapshotExposure[];
  elapsedMs: number;
  consistency: string;
  verified: boolean;
  readEpoch: number | null;
  cypher: string;
}

export interface TimeMachineResponse {
  timeMachine: TimeMachineReport;
  exposedNow: ExposedRepo[];
  historical: ExposedRepo[];
  allExposures: SnapshotExposure[];
}

export interface GraphNode {
  id: number;
  label: 'Version' | 'LockfileSnapshot' | 'Repo';
  key: string;
  name: string;
  depth: number;
  isCurrent: boolean;
  isCompromised: boolean;
  capturedAt: number;
}

export interface GraphResponse {
  source: VersionRef;
  nodes: GraphNode[];
  links: Array<{ source: number; target: number; type: string }>;
  elapsedMs: number;
  truncated: boolean;
}

export interface MaintainerReport {
  package: { key: string; name: string; downloads: number; dependentCount: number };
  maintainers: Array<{ key: string; username: string; packageCount: number }>;
  neighbors: Array<{
    packageKey: string;
    packageName: string;
    sharedMaintainers: string[];
    downloads: number;
    isOrgDependency: boolean;
  }>;
  orgExposedNeighbors: unknown[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  riskReason: string;
  elapsedMs: number;
  cypher: string;
}

export interface TyposquatFinding {
  trustedKey: string;
  trustedName: string;
  candidateKey: string;
  candidateName: string;
  distance: number;
  score: number;
  reason: string;
  candidateDownloads: number;
  candidateCreatedAt: number;
  candidateAgeDays: number;
  verdict: 'SUSPICIOUS' | 'WATCH' | 'LIKELY_LEGITIMATE';
  rationale: string;
}

export interface StatsResponse {
  stats: Record<string, number>;
  compromised: VersionRef[];
  repos: Array<{ key: string; name: string; language: string; lockfileSource: string }>;
  org: string;
  simulatedNow: number;
  traversal: { maxDepth: number; pathCount: number };
}

export interface ScenarioSummary {
  name: string;
  title: string;
  description: string;
  reference: string;
  windowMinutes: number;
  artifactCount: number;
  propagationTargets: number;
  from: number;
  to: number;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* keep raw */
    }
    throw new Error(message);
  }
  return JSON.parse(text) as T;
}

export const api = {
  stats: () => get<StatsResponse>('/api/stats'),
  scenarios: () => get<ScenarioSummary[]>('/api/scenarios'),
  search: (query: string) =>
    get<Array<{ key: string; name: string; dependent_count: number; downloads: number }>>(
      `/api/search?q=${encodeURIComponent(query)}`,
    ),
  versions: (packageKey: string) =>
    get<{ versions: VersionRef[]; timeline: unknown[] }>(
      `/api/versions?package=${encodeURIComponent(packageKey)}`,
    ),
  exposure: (versionKey: string, options: { verified?: boolean; repos?: string[] } = {}) => {
    const params = new URLSearchParams({ version: versionKey });
    if (options.verified) params.set('verified', 'true');
    if (options.repos?.length) params.set('repos', options.repos.join(','));
    return get<BlastRadiusReport>(`/api/exposure?${params.toString()}`);
  },
  graph: (versionKey: string, verified = false) =>
    get<GraphResponse>(
      `/api/graph?version=${encodeURIComponent(versionKey)}${verified ? '&verified=true' : ''}`,
    ),
  timeMachine: (versionKey: string, options: { verified?: boolean } = {}) =>
    get<TimeMachineResponse>(
      `/api/time-machine?version=${encodeURIComponent(versionKey)}` +
        (options.verified ? '&verified=true' : ''),
    ),
  asOf: (versionKey: string, at: number) =>
    get<{ instant: number; exposures: SnapshotExposure[] }>(
      `/api/time-machine/as-of?version=${encodeURIComponent(versionKey)}&at=${at}`,
    ),
  maintainers: (packageKey: string) =>
    get<MaintainerReport>(`/api/maintainers?package=${encodeURIComponent(packageKey)}`),
  typosquats: () =>
    get<{ findings: TyposquatFinding[]; elapsedMs: number; cypher: string }>('/api/typosquats'),
};

export const fmtTime = (ms: number): string =>
  ms ? new Date(ms).toISOString().slice(11, 19) + 'Z' : '—';

export const fmtDate = (ms: number): string =>
  ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : '—';

export const fmtMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
