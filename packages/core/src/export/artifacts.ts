/**
 * Exportable artifacts.
 *
 * A tool that can only show you things inside its own UI is a demo. These are
 * the formats the surrounding ecosystem actually consumes — a CycloneDX SBOM
 * that any scanner can read, an incident report an on-call engineer can paste
 * into a ticket, and a DOT graph for external visualisation.
 */
import type { HydraClient, QueryOptions } from '../hydra/client.js';
import type { BlastRadiusReport } from '../queries/blastRadius.js';
import type { TimeMachineReport } from '../queries/timeMachine.js';
import type { RemediationPlan } from '../queries/remediation.js';
import type { PrioritisedReport } from '../queries/insights.js';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

// --- CycloneDX SBOM ---------------------------------------------------------

export interface CycloneDxComponent {
  type: 'library';
  'bom-ref': string;
  name: string;
  version: string;
  purl: string;
  scope?: 'required' | 'optional';
}

export interface CycloneDxBom {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: { type: 'application'; 'bom-ref': string; name: string; version: string };
  };
  components: CycloneDxComponent[];
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
  vulnerabilities?: Array<{
    'bom-ref': string;
    id: string;
    source: { name: string; url: string };
    ratings: Array<{ severity: string }>;
    description: string;
    affects: Array<{ ref: string }>;
  }>;
}

/** package URL for an npm component: `pkg:npm/%40scope%2Fname@1.2.3` */
export function purlFor(packageName: string, version: string): string {
  const encoded = packageName.startsWith('@')
    ? `%40${encodeURIComponent(packageName.slice(1).replace('/', '%2F')).replace('%2540', '%40')}`
    : encodeURIComponent(packageName);
  // npm scoped names encode the slash; keep it readable and spec-valid.
  const name = packageName.startsWith('@')
    ? `%40${packageName.slice(1).split('/')[0]}%2F${packageName.split('/')[1] ?? ''}`
    : encoded;
  return `pkg:npm/${name}@${version}`;
}

/**
 * Emit the current lockfile of a repo as a CycloneDX 1.5 SBOM, including
 * dependency relationships and any advisories the graph knows about.
 */
export async function exportSbom(
  client: HydraClient,
  repoKey: string,
  options: { consistency?: QueryOptions['consistency']; serialNumber?: string; timestamp?: string } = {},
): Promise<CycloneDxBom> {
  const snapshot = await client.query(
    'MATCH (s:LockfileSnapshot) WHERE s.repo_key = $repo_key AND s.is_current = true ' +
      'RETURN s.key AS key, s.repo_name AS repo_name, s.captured_at AS captured_at LIMIT 1',
    { consistency: options.consistency, parameters: { repo_key: repoKey } },
  );
  const snapshotKey = str(snapshot.records[0]?.key);
  if (!snapshotKey) throw new Error(`no current lockfile for repo: ${repoKey}`);
  const repoName = str(snapshot.records[0]?.repo_name);

  const pinned = await client.query(
    'MATCH (s:LockfileSnapshot {id: $sid})-[r:RESOLVED]->(v:Version) ' +
      'RETURN v.key AS key, v.package_name AS name, v.version_string AS version, ' +
      'r.direct AS direct ORDER BY name',
    {
      consistency: options.consistency,
      parameters: { sid: num((await snapshotId(client, snapshotKey, options)) ?? 0) },
    },
  );

  const components: CycloneDxComponent[] = pinned.records.map((record) => {
    const name = str(record.name);
    const version = str(record.version);
    return {
      type: 'library',
      'bom-ref': purlFor(name, version),
      name,
      version,
      purl: purlFor(name, version),
      scope: record.direct === true ? 'required' : 'optional',
    };
  });

  // Dependency relationships, restricted to components in this SBOM.
  const inBom = new Set(pinned.records.map((r) => str(r.key)));
  const edges = await client.query(
    'MATCH (a:Version)-[:RESOLVED_TO]->(b:Version) RETURN a.key AS from_key, b.key AS to_key',
    { consistency: options.consistency },
  );
  const refFor = new Map(
    pinned.records.map((r) => [str(r.key), purlFor(str(r.name), str(r.version))]),
  );
  const dependsOn = new Map<string, Set<string>>();
  for (const record of edges.records) {
    const from = str(record.from_key);
    const to = str(record.to_key);
    if (!inBom.has(from) || !inBom.has(to)) continue;
    const set = dependsOn.get(from) ?? new Set<string>();
    set.add(refFor.get(to)!);
    dependsOn.set(from, set);
  }

  // Advisories affecting anything in this SBOM.
  const advisoryRows = await client.query(
    'MATCH (a:Advisory)-[:AFFECTS]->(v:Version) ' +
      'RETURN a.key AS id, a.summary AS summary, a.severity AS severity, v.key AS version_key',
    { consistency: options.consistency },
  );
  const vulnerabilities: NonNullable<CycloneDxBom['vulnerabilities']> = [];
  const byAdvisory = new Map<string, { summary: string; severity: string; refs: Set<string> }>();
  for (const record of advisoryRows.records) {
    const versionKey = str(record.version_key);
    if (!inBom.has(versionKey)) continue;
    const id = str(record.id);
    const entry = byAdvisory.get(id) ?? {
      summary: str(record.summary),
      severity: str(record.severity),
      refs: new Set<string>(),
    };
    entry.refs.add(refFor.get(versionKey)!);
    byAdvisory.set(id, entry);
  }
  for (const [id, entry] of byAdvisory) {
    vulnerabilities.push({
      'bom-ref': id,
      id,
      source: { name: 'OSV', url: `https://osv.dev/vulnerability/${id}` },
      ratings: [{ severity: entry.severity.toLowerCase() }],
      description: entry.summary,
      affects: [...entry.refs].map((ref) => ({ ref })),
    });
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    // Deterministic when a serial is supplied, so SBOM diffs are meaningful.
    serialNumber: options.serialNumber ?? `urn:uuid:${deterministicUuid(snapshotKey)}`,
    version: 1,
    metadata: {
      timestamp: options.timestamp ?? new Date(num(snapshot.records[0]?.captured_at)).toISOString(),
      tools: [{ vendor: 'blast-radius', name: 'blastradius', version: '1.0.0' }],
      component: {
        type: 'application',
        'bom-ref': `repo:${repoKey}`,
        name: repoName || repoKey,
        version: '0.0.0',
      },
    },
    components,
    dependencies: [...dependsOn.entries()].map(([from, tos]) => ({
      ref: refFor.get(from)!,
      dependsOn: [...tos].sort(),
    })),
    ...(vulnerabilities.length > 0 ? { vulnerabilities } : {}),
  };
}

async function snapshotId(
  client: HydraClient,
  snapshotKey: string,
  options: { consistency?: QueryOptions['consistency'] },
): Promise<number | null> {
  const result = await client.query(
    'MATCH (s:LockfileSnapshot) WHERE s.key = $key RETURN s.id AS id LIMIT 1',
    { consistency: options.consistency, parameters: { key: snapshotKey } },
  );
  const id = result.records[0]?.id;
  return typeof id === 'number' ? id : null;
}

/** Stable UUIDv5-shaped identifier derived from a string, so re-exporting the
 *  same snapshot yields the same serial number. */
function deterministicUuid(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i), 2246822519) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  const a = hex(h1);
  const b = hex(h2);
  const c = hex((h1 ^ h2) >>> 0);
  const d = hex((h1 + h2) >>> 0);
  return `${a}-${b.slice(0, 4)}-5${b.slice(5, 8)}-a${c.slice(1, 4)}-${c.slice(4)}${d}`;
}

// --- incident report --------------------------------------------------------

export interface IncidentReportInput {
  blast: BlastRadiusReport;
  timeMachine: TimeMachineReport | null;
  remediation: RemediationPlan | null;
  prioritised: PrioritisedReport | null;
  generatedAt: number;
}

/** The whole incident as a Markdown document an engineer can paste into a ticket. */
export function renderIncidentReport(input: IncidentReportInput): string {
  const { blast, timeMachine, remediation, prioritised } = input;
  const iso = (ms: number) => (ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : '—');
  const out: string[] = [];

  out.push(`# Incident report — ${blast.source.key}`);
  out.push('');
  out.push(`Generated ${iso(input.generatedAt)} by Blast Radius.`);
  out.push('');

  if (blast.source.isCompromised) {
    const seconds = Math.round((blast.source.compromisedTo - blast.source.compromisedFrom) / 1000);
    out.push(`**Compromise window** ${iso(blast.source.compromisedFrom)} → ${iso(blast.source.compromisedTo)} (${seconds}s)`);
    if (blast.source.advisoryId) out.push(`**Advisory** ${blast.source.advisoryId}`);
    out.push('');
  }

  out.push('## Summary');
  out.push('');
  out.push(`- **${blast.exposedRepos.length}** repositories are exposed right now.`);
  if (timeMachine) {
    out.push(`- **${timeMachine.duringWindow.length}** had a lockfile that resolved this version *while it was live*.`);
    const cleanNow = timeMachine.duringWindow.filter((e) => !e.isCurrent).length;
    if (cleanNow > 0) {
      out.push(`- **${cleanNow}** of those are clean today — a current-state scanner reports them safe, but they ran the malicious build.`);
    }
  }
  out.push(`- **${blast.exposedPackages.length}** package versions in the dependency graph sit downstream of it.`);
  out.push('');

  if (prioritised && prioritised.ranked.length > 0) {
    out.push('## Fix in this order');
    out.push('');
    out.push('| # | Repository | Priority | Depth | Why |');
    out.push('|---|---|---|---|---|');
    prioritised.ranked.forEach((entry, index) => {
      out.push(
        `| ${index + 1} | \`${entry.repoName}\` | ${entry.priority.toFixed(2)} | ${entry.depth} | ` +
          `severity ${entry.factors.severity}, proximity ${entry.factors.proximity}` +
          `${entry.direct ? ', direct dependency' : ''} |`,
      );
    });
    out.push('');
  }

  out.push('## Currently exposed');
  out.push('');
  if (blast.exposedRepos.length === 0) out.push('_None._');
  else {
    out.push('| Repository | Depth | Dependency chain |');
    out.push('|---|---|---|');
    for (const e of blast.exposedRepos) {
      out.push(`| \`${e.repoName}\` | ${e.depth} | \`${e.chainText}\` |`);
    }
  }
  out.push('');

  if (timeMachine) {
    out.push('## Exposed during the compromise window');
    out.push('');
    out.push(`Window: ${iso(timeMachine.windowFrom)} → ${iso(timeMachine.windowTo)}`);
    out.push('');
    if (timeMachine.duringWindow.length === 0) out.push('_No lockfile was captured inside the window._');
    else {
      out.push('| Repository | Lockfile captured | Still current? |');
      out.push('|---|---|---|');
      for (const e of timeMachine.duringWindow) {
        out.push(`| \`${e.repoName}\` | ${iso(e.capturedAt)} | ${e.isCurrent ? 'yes' : `no, superseded ${iso(e.supersededAt)}`} |`);
      }
      out.push('');
      const historical = timeMachine.duringWindow.filter((e) => !e.isCurrent).map((e) => e.repoName);
      if (historical.length > 0) {
        out.push(
          `> **${historical.length} repositories (${historical.join(', ')}) are clean today but ran the malicious build.** ` +
            `They will not appear in any current-state scan and still need a security review.`,
        );
      }
    }
    out.push('');
  }

  if (remediation && remediation.distinctChanges.length > 0) {
    out.push('## Remediation');
    out.push('');
    out.push('| Change | Package | From | To | Clears |');
    out.push('|---|---|---|---|---|');
    for (const change of remediation.distinctChanges) {
      out.push(
        `| ${change.direction === 'rollback' ? 'roll back' : 'upgrade'} | \`${change.packageName}\` | ` +
          `${change.from.join(', ')} | **${change.to}** | ${change.repos.join(', ')} |`,
      );
    }
    const noFix = remediation.fixes.filter((f) => f.targetVersion === null);
    if (noFix.length > 0) {
      out.push('');
      out.push(`> ${noFix.length} repositories have no safe published version and need an upstream fix.`);
    }
    out.push('');
  }

  out.push('## How this was determined');
  out.push('');
  out.push('Every figure above is a live query against a HydraDB property graph:');
  out.push('');
  out.push('```cypher');
  out.push(blast.cypher);
  out.push('```');
  out.push('');
  out.push(
    `Traversal completed in ${Math.round(blast.elapsedMs)}ms over ${blast.totalPaths} paths ` +
      `(${blast.procedure}, ${blast.consistency} consistency).`,
  );

  return out.join('\n');
}

// --- graph export -----------------------------------------------------------

/** Graphviz DOT of a blast radius, for external rendering. */
export function renderDot(report: BlastRadiusReport): string {
  const lines: string[] = [];
  const id = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  lines.push('digraph blast_radius {');
  lines.push('  rankdir=LR;');
  lines.push('  bgcolor="#0b0e14";');
  lines.push('  node [style=filled, fontname="Helvetica", fontcolor="#dbe2f0", color="#232b3d"];');
  lines.push('  edge [color="#46516b"];');
  lines.push(`  ${id(report.source.key)} [fillcolor="#ff5c6c", fontcolor="#1a0508", shape=doubleoctagon];`);

  const seen = new Set<string>([report.source.key]);
  for (const exposure of report.exposedRepos) {
    for (const link of exposure.chain) {
      if (!seen.has(link.key)) {
        seen.add(link.key);
        const fill = link.kind === 'repo' ? '#4ec9a5' : '#4da3ff';
        const shape = link.kind === 'repo' ? 'box' : 'ellipse';
        lines.push(`  ${id(link.key)} [fillcolor="${fill}", fontcolor="#07131f", shape=${shape}, label=${id(link.label)}];`);
      }
    }
    for (let i = 0; i < exposure.chain.length - 1; i++) {
      lines.push(`  ${id(exposure.chain[i]!.key)} -> ${id(exposure.chain[i + 1]!.key)};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}
