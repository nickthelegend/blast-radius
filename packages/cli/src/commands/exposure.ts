import {
  blastRadius,
  blastRadiusForRepos,
  buildVersionTimeline,
  findVersion,
  listRepos,
  listVersionsOfPackage,
  resolveRepoKeys,
  type BlastRadiusReport,
} from '@blast/core';

import { createContext, fail } from '../context.js';
import { bold, cyan, dim, duration, green, iso, pad, red, wrapChain, yellow } from '../format.js';

export interface ExposureOptions {
  repos?: string;
  depth?: string;
  json?: boolean;
  verified?: boolean;
  pairwise?: boolean;
  whichVersion?: boolean;
  showPaths?: boolean;
}

export async function exposureCommand(versionKey: string, options: ExposureOptions): Promise<void> {
  const { config, client } = createContext();

  const source = await findVersion(client, versionKey);
  if (!source) {
    fail(
      `version not found in the graph: ${versionKey}\n` +
        `Check it is loaded with \`blastradius stats\`, or load the graph with \`make demo\`.`,
    );
  }

  const maxDepth = options.depth ? Number(options.depth) : config.traversal.maxDepth;
  if (!Number.isFinite(maxDepth) || maxDepth < 1) fail(`--depth must be a positive integer`);

  const consistency = options.verified
    ? config.traversal.verifiedConsistency
    : config.traversal.readConsistency;

  const traversal = {
    maxDepth,
    pathCount: config.traversal.pathCount,
    resultLimit: config.traversal.resultLimit,
    consistency,
  };

  let report: BlastRadiusReport;

  if (options.repos) {
    const names = options.repos
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const { resolved, missing } = await resolveRepoKeys(client, names, config.org.name);
    if (missing.length > 0) {
      const available = (await listRepos(client, config.org.name)).map((repo) => repo.name);
      fail(
        `unknown repo${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}\n` +
          `Known repos: ${available.join(', ')}`,
      );
    }
    report = await blastRadiusForRepos(
      client,
      source,
      resolved.map((repo) => repo.key),
      { ...traversal, pairwise: options.pairwise ?? false },
    );
  } else {
    report = await blastRadius(client, source, traversal);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printReport(report, { showPaths: options.showPaths ?? true });

  if (options.whichVersion) {
    const versions = await listVersionsOfPackage(client, source.packageKey);
    printVersionTimeline(source.packageName, versions);
  }
}

export function printReport(
  report: BlastRadiusReport,
  options: { showPaths: boolean } = { showPaths: true },
): void {
  const out = process.stdout;
  out.write(`${bold(`BLAST RADIUS REPORT — ${report.source.key}`)}\n`);

  if (report.source.isCompromised) {
    out.write(
      dim(
        `compromise window ${iso(report.source.compromisedFrom)} → ${iso(report.source.compromisedTo)}` +
          (report.source.advisoryId ? `  (${report.source.advisoryId})` : '') +
          '\n',
      ),
    );
  }

  const label =
    report.consistency === 'strong'
      ? 'live graph, strong read (pinned snapshot)'
      : 'live graph, causal read';
  out.write(`${bold(`Currently exposed (${label}):`)}\n`);

  if (report.exposedRepos.length === 0) {
    out.write(`  ${green('none')} — no current lockfile resolves this version\n`);
  }

  for (const exposure of report.exposedRepos) {
    const head = `  repo: ${pad(exposure.repoName, 24)} depth ${exposure.depth}`;
    if (!options.showPaths) {
      out.write(`${red(head)}\n`);
      continue;
    }
    const indent = head.length + 3;
    const lines = wrapChain(exposure.chainText, indent);
    out.write(`${red(head)}   path: ${lines[0] ?? ''}\n`);
    for (const line of lines.slice(1)) {
      out.write(`${' '.repeat(indent + 6)}${line}\n`);
    }
    if (exposure.direct) out.write(`${' '.repeat(indent + 6)}${yellow('(direct dependency)')}\n`);
  }

  if (report.historicallyExposedRepos.length > 0) {
    out.write(
      `\n${bold('Exposed only through a superseded lockfile')} ` +
        `${dim('(upgraded since — see `blastradius time-machine`)')}:\n`,
    );
    for (const exposure of report.historicallyExposedRepos) {
      out.write(
        `  repo: ${pad(exposure.repoName, 24)} depth ${exposure.depth}   ` +
          dim(`lockfile ${iso(exposure.snapshotCapturedAt)}`) +
          '\n',
      );
    }
  }

  out.write(
    `\n${dim(`Exposed packages in the dependency graph: ${report.exposedPackages.length}`)}\n`,
  );

  const detail = `${report.procedure}, maxLen=${report.maxDepthUsed + 2}, pathCount=${report.pathCountUsed}`;
  out.write(`${bold('Query time:')} ${cyan(duration(report.elapsedMs))}  ${dim(`(${detail})`)}\n`);
  out.write(dim(`Paths returned: ${report.totalPaths}\n`));

  if (report.truncated) {
    out.write(
      yellow(
        `\nWARNING: the traversal returned exactly its path budget (${report.pathCountUsed}), ` +
          `so this report may be incomplete.\nRaise BLAST_PATH_COUNT and re-run.\n`,
      ),
    );
  }
}

export function printVersionTimeline(
  packageName: string,
  versions: Parameters<typeof buildVersionTimeline>[0],
): void {
  const out = process.stdout;
  const timeline = buildVersionTimeline(versions);
  out.write(`\n${bold(`VERSION TIMELINE — ${packageName}`)}\n`);
  for (const entry of timeline) {
    const marker = entry.introducesVulnerability
      ? red(' ← introduced here')
      : entry.affected
        ? red(' (affected)')
        : green(' ok');
    const advisory = entry.advisoryId ? dim(`  ${entry.advisoryId}`) : '';
    out.write(
      `  ${pad(entry.versionString, 14)} ${dim(iso(entry.publishedAt))}${marker}${advisory}\n`,
    );
  }
}
