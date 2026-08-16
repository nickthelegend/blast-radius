/**
 * Typosquat proximity.
 *
 * `NAME_SIMILAR_TO` edges are precomputed at load time rather than at query
 * time, because comparing every package against every other is quadratic. The
 * comparison is deliberately scoped: candidates from the whole ingested graph
 * are matched only against the org's own most-depended-on packages. That turns
 * the check into "packages that look suspiciously like something you already
 * trust" instead of registry-wide noise.
 *
 * Proximity alone is not a verdict. `react` and `preact` are one edit apart and
 * both real. So the graph stores the edge and the *reason*, and the verdict
 * comes from combining that with the candidate's age and download volume — a
 * four-day-old package with 12 downloads that is one keystroke from your
 * logging library is a very different object from a 400-day-old package with
 * two million weekly downloads.
 */
import type { HydraClient, QueryOptions } from '../hydra/client.js';
import type { NameSimilarEdge, PackageNode } from '../model/types.js';
import { proximity } from '../typosquat/distance.js';

export type TyposquatVerdict = 'SUSPICIOUS' | 'WATCH' | 'LIKELY_LEGITIMATE';

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
  verdict: TyposquatVerdict;
  rationale: string;
}

export interface TyposquatOptions {
  recentDays: number;
  lowDownloadThreshold: number;
  now?: number;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * Precompute NAME_SIMILAR_TO edges.
 * `trusted` is the org's top-N dependency set; `candidates` is every package in
 * the graph.
 */
export function computeSimilarityEdges(
  trusted: PackageNode[],
  candidates: PackageNode[],
  options: { maxDistance: number; minNameLength: number },
): NameSimilarEdge[] {
  const edges: NameSimilarEdge[] = [];
  const trustedKeys = new Set(trusted.map((pkg) => pkg.key));

  for (const trustedPkg of trusted) {
    if (trustedPkg.name.length < options.minNameLength) continue;
    for (const candidate of candidates) {
      if (candidate.key === trustedPkg.key) continue;
      if (candidate.name.length < options.minNameLength) continue;
      // Two trusted packages resembling each other is not a finding.
      if (trustedKeys.has(candidate.key) && candidate.downloads > trustedPkg.downloads) continue;

      const result = proximity(candidate.name, trustedPkg.name, options.maxDistance);
      if (!result) continue;

      edges.push({
        from_package_key: trustedPkg.key,
        to_package_key: candidate.key,
        distance: result.distance,
        score: result.score,
        reason: result.reason,
      });
    }
  }

  return edges.sort((a, b) => b.score - a.score);
}

function classify(
  finding: Omit<TyposquatFinding, 'verdict' | 'rationale'>,
  options: TyposquatOptions,
): Pick<TyposquatFinding, 'verdict' | 'rationale'> {
  const isRecent = finding.candidateAgeDays <= options.recentDays;
  const isLowVolume = finding.candidateDownloads < options.lowDownloadThreshold;

  // Low download counts alone must not escalate a weak name match. Most of npm
  // has few downloads, so without a score floor every distant coincidence would
  // be reported as suspicious and bury the real findings.
  const strongPattern = finding.score >= 0.6;

  if (isRecent && isLowVolume && strongPattern) {
    return {
      verdict: 'SUSPICIOUS',
      rationale:
        `published ${Math.round(finding.candidateAgeDays)} days ago with ` +
        `${finding.candidateDownloads.toLocaleString()} weekly downloads`,
    };
  }
  if (isLowVolume && finding.score >= 0.85) {
    return {
      verdict: 'SUSPICIOUS',
      rationale:
        `${finding.candidateDownloads.toLocaleString()} weekly downloads and a high-risk edit pattern`,
    };
  }
  if ((isRecent || isLowVolume) && strongPattern) {
    return {
      verdict: 'WATCH',
      rationale: isRecent
        ? `published ${Math.round(finding.candidateAgeDays)} days ago`
        : `${finding.candidateDownloads.toLocaleString()} weekly downloads`,
    };
  }
  // Age is unknown for packages whose publish date never made it into the graph;
  // saying "published Infinity days ago" is worse than saying nothing.
  const age = Number.isFinite(finding.candidateAgeDays)
    ? `, published ${Math.round(finding.candidateAgeDays)} days ago`
    : ', publish date unknown';
  return {
    verdict: 'LIKELY_LEGITIMATE',
    rationale: `${finding.candidateDownloads.toLocaleString()} weekly downloads${age}`,
  };
}

export async function typosquats(
  client: HydraClient,
  options: TyposquatOptions & { consistency?: QueryOptions['consistency'] },
): Promise<{ findings: TyposquatFinding[]; elapsedMs: number; cypher: string }> {
  const cypher =
    'MATCH (trusted:Package)-[r:NAME_SIMILAR_TO]->(candidate:Package) ' +
    'RETURN trusted.key AS trusted_key, trusted.name AS trusted_name, ' +
    'candidate.key AS candidate_key, candidate.name AS candidate_name, ' +
    'candidate.downloads AS downloads, candidate.created_at AS created_at, ' +
    'r.distance AS distance, r.score AS score, r.reason AS reason ' +
    'ORDER BY score DESC';

  const result = await client.query(cypher, { consistency: options.consistency });
  const now = options.now ?? Date.now();

  const findings = result.records.map((record) => {
    const createdAt = numberOf(record.created_at);
    const base = {
      trustedKey: str(record.trusted_key),
      trustedName: str(record.trusted_name),
      candidateKey: str(record.candidate_key),
      candidateName: str(record.candidate_name),
      distance: numberOf(record.distance),
      score: numberOf(record.score),
      reason: str(record.reason),
      candidateDownloads: numberOf(record.downloads),
      candidateCreatedAt: createdAt,
      candidateAgeDays: createdAt > 0 ? (now - createdAt) / 86_400_000 : Number.POSITIVE_INFINITY,
    };
    return { ...base, ...classify(base, options) };
  });

  const rank: Record<TyposquatVerdict, number> = {
    SUSPICIOUS: 0,
    WATCH: 1,
    LIKELY_LEGITIMATE: 2,
  };
  findings.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.score - a.score);

  return { findings, elapsedMs: result.elapsedMs, cypher };
}
