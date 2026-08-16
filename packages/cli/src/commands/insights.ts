import { writeFileSync } from 'node:fs';

import {
  advisories,
  blastRadius,
  explainPath,
  exportSbom,
  findVersion,
  listCompromisedVersions,
  maintainerBlastRadius,
  planRemediation,
  preflight,
  prioritiseExposure,
  renderDot,
  renderIncidentReport,
  renderSarif,
  timeMachine,
} from '@blast/core';

import { createContext, fail, requireVersion } from '../context.js';
import { bar, bold, cyan, dim, duration, green, iso, pad, red, yellow } from '../format.js';

const traversalFrom = (config: ReturnType<typeof createContext>['config'], depth?: string) => ({
  maxDepth: depth ? Number(depth) : config.traversal.maxDepth,
  pathCount: config.traversal.pathCount,
  resultLimit: config.traversal.resultLimit,
});

/** `blastradius prioritise <version>` — the ordered worklist. */
export async function prioritiseCommand(
  versionKey: string,
  options: { json?: boolean; depth?: string },
): Promise<void> {
  const { config, client } = createContext();
  const version = await requireVersion(client, versionKey);

  const report = await prioritiseExposure(client, version, traversalFrom(config, options.depth));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`${bold(`REMEDIATION PRIORITY — ${versionKey}`)}\n`);
  out.write(
    dim(
      `  advisory ${report.advisoryId || 'none in graph'}` +
        `${report.advisoryId ? ` (${report.advisorySeverity})` : ''}\n\n`,
    ),
  );

  if (report.ranked.length === 0) {
    out.write(`  ${green('nothing exposed')}\n`);
    return;
  }

  for (const [index, entry] of report.ranked.entries()) {
    const color = entry.priority > 0.7 ? red : entry.priority > 0.5 ? yellow : green;
    out.write(
      `  ${pad(`${index + 1}.`, 4)} ${pad(entry.repoName, 24)} ` +
        `${color(entry.priority.toFixed(2))} ${bar(entry.priority, 1, 18)}\n`,
    );
    out.write(
      dim(
        `       depth ${entry.depth} · severity ${entry.factors.severity} · ` +
          `proximity ${entry.factors.proximity}${entry.direct ? ' · direct dependency' : ''}\n`,
      ),
    );
  }
  out.write(`\n${bold('Query time:')} ${cyan(duration(report.elapsedMs))}\n`);
}

/** `blastradius preflight` — what would hurt most if compromised tomorrow. */
export async function preflightCommand(options: {
  json?: boolean;
  limit?: string;
}): Promise<void> {
  const { config, client } = createContext();
  const out = process.stdout;
  const limit = options.limit ? Number(options.limit) : 15;

  if (!options.json) {
    out.write(`${bold('PREFLIGHT — what would a compromise cost us?')}\n`);
    out.write(dim(`  running a real blast-radius traversal for the ${limit} most-pinned versions\n\n`));
  }

  const report = await preflight(client, {
    ...traversalFrom(config),
    limit,
    onProgress: (done, total) => {
      if (!options.json && process.stdout.isTTY) {
        out.write(`\r\u001b[2K  testing ${done}/${total}…`);
      }
    },
  });

  if (options.json) {
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  // Clear the progress line rather than overwriting it with spaces, which
  // would leave padding in front of the first result row.
  if (process.stdout.isTTY) out.write('\r\u001b[2K');
  const worst = Math.max(1, ...report.entries.map((e) => e.exposedRepos));
  for (const entry of report.entries) {
    const color = entry.exposedRepos >= worst * 0.7 ? red : entry.exposedRepos > 0 ? yellow : green;
    out.write(
      `  ${pad(entry.packageName, 26)} ${color(pad(String(entry.exposedRepos), 3))} repos  ` +
        `${bar(entry.exposedRepos, worst, 20)} ` +
        dim(`depth ${entry.maxDepth} · ${entry.maintainers} maintainer(s)`) +
        '\n',
    );
  }
  out.write(
    `\n${dim(`${report.candidatesTested} versions tested · ${duration(report.elapsedMs)}`)}\n`,
  );
  out.write(
    dim('These are not compromised. This is what it would cost if they were.\n'),
  );
}

/** `blastradius why <repo> <version>` — the chain that pulled a package in. */
export async function whyCommand(
  repoName: string,
  versionKey: string,
  options: { json?: boolean; depth?: string },
): Promise<void> {
  const { config, client } = createContext();
  const repoKey = repoName.includes('/') ? repoName : `${config.org.name}/${repoName}`;

  let explanation;
  try {
    explanation = await explainPath(client, repoKey, versionKey, traversalFrom(config, options.depth));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(explanation, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`${bold(`WHY IS ${versionKey} IN ${repoName}?`)}\n`);
  if (!explanation.found) {
    out.write(
      `  ${green('it is not')} — no path within ${config.traversal.maxDepth} hops.\n` +
        dim('  Either the repo does not ship it, or the chain is longer than --depth.\n'),
    );
    return;
  }
  out.write(`  ${explanation.chainText}\n`);
  out.write(dim(`  ${explanation.hops} dependency hop(s)\n`));
  out.write(`\n${bold('Query time:')} ${cyan(duration(explanation.elapsedMs))} ${dim('(algo.SPpaths)')}\n`);
}

/** `blastradius maintainer-radius <username>` — account-level blast radius. */
export async function maintainerRadiusCommand(
  username: string,
  options: { json?: boolean },
): Promise<void> {
  const { config, client } = createContext();
  let report;
  try {
    report = await maintainerBlastRadius(client, username, traversalFrom(config));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`${bold(`ACCOUNT BLAST RADIUS — ${username}`)}\n`);
  out.write(dim('  if this publish credential were stolen today\n\n'));
  out.write(`  ${bold('can publish to:')} ${report.packages.length} package(s)\n`);
  out.write(dim(`    ${report.packages.map((p) => p.name).join(', ')}\n\n`));
  if (report.exposedRepos.length === 0) {
    out.write(`  ${green('no repository currently pins any of them')}\n`);
  } else {
    out.write(`  ${red(`${report.exposedRepos.length} of your repositories would be reachable:`)}\n`);
    for (const repo of report.exposedRepos) out.write(`    ${red(repo)}\n`);
  }
  out.write(`\n${bold('Query time:')} ${cyan(duration(report.elapsedMs))}\n`);
}

/** `blastradius advisories` — the real OSV records in the graph. */
export async function advisoriesCommand(options: { json?: boolean }): Promise<void> {
  const { client } = createContext();
  const report = await advisories(client);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`${bold('ADVISORIES IN THE GRAPH')} ${dim('(real OSV.dev records)')}\n\n`);
  for (const advisory of report.advisories) {
    const reach = advisory.exposedRepos.length;
    const past = advisory.historicalRepos.length;
    const color = reach > 0 ? red : past > 0 ? yellow : dim;
    out.write(
      `  ${pad(advisory.id, 22)} ${pad(advisory.severity, 10)} ` +
        `${color(`${reach} now`)} ${past > 0 ? yellow(`${past} then`) : dim('0 then')} ` +
        `${dim(`${advisory.affectedCount} version(s)`)}\n`,
    );
    if (advisory.summary) out.write(dim(`    ${advisory.summary.slice(0, 92)}\n`));
    if (reach > 0) out.write(`    ${red(`exposed now: ${advisory.exposedRepos.join(', ')}`)}\n`);
    if (past > 0) out.write(`    ${yellow(`shipped it: ${advisory.historicalRepos.join(', ')}`)}\n`);
  }

  const everShipped = new Set(report.advisories.flatMap((a) => a.historicalRepos));
  const liveCount = report.advisories.filter((a) => a.exposedRepos.length > 0).length;
  out.write(`\n${dim(`${report.advisories.length} advisories · ${duration(report.elapsedMs)}`)}\n`);

  if (liveCount === 0 && everShipped.size > 0) {
    // The headline finding on a well-maintained estate, and the one a
    // current-state scanner structurally cannot produce.
    out.write(
      `\n${yellow('No advisory affects a current lockfile')} — every one of these was upgraded away from.\n` +
        `But ${bold(String(everShipped.size))} repositories shipped an affected version at some point: ` +
        `${yellow([...everShipped].sort().join(', '))}.\n` +
        dim('A scanner that only reads current lockfiles reports all of this as clean.\n'),
    );
  }
}

/** `blastradius sbom <repo>` — CycloneDX export. */
export async function sbomCommand(
  repoName: string,
  options: { out?: string },
): Promise<void> {
  const { config, client } = createContext();
  const repoKey = repoName.includes('/') ? repoName : `${config.org.name}/${repoName}`;

  let bom;
  try {
    bom = await exportSbom(client, repoKey);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const json = `${JSON.stringify(bom, null, 2)}\n`;
  if (options.out) {
    writeFileSync(options.out, json);
    process.stdout.write(
      `${green('wrote')} ${options.out}\n` +
        dim(`  ${bom.components.length} components, ${bom.dependencies.length} dependency records`) +
        `${bom.vulnerabilities ? dim(`, ${bom.vulnerabilities.length} vulnerabilities`) : ''}\n`,
    );
    return;
  }
  process.stdout.write(json);
}

/** `blastradius report <version>` — the whole incident as Markdown. */
export async function reportCommand(
  versionKey: string,
  options: { out?: string; depth?: string },
): Promise<void> {
  const { config, client } = createContext();
  const version = await requireVersion(client, versionKey);

  const traversal = traversalFrom(config, options.depth);
  const blast = await blastRadius(client, version, traversal);
  const prioritised = await prioritiseExposure(client, version, traversal);
  const remediation = await planRemediation(client, blast, traversal);
  let tm = null;
  try {
    tm = await timeMachine(client, version, { verified: true });
  } catch {
    // No compromise window set — the report simply omits that section.
  }

  const markdown = renderIncidentReport({
    blast,
    timeMachine: tm,
    remediation,
    prioritised,
    generatedAt: Date.now(),
  });

  if (options.out) {
    writeFileSync(options.out, `${markdown}\n`);
    process.stdout.write(`${green('wrote')} ${options.out} ${dim(`(${markdown.split('\n').length} lines)`)}\n`);
    return;
  }
  process.stdout.write(`${markdown}\n`);
}

/** `blastradius graph-export <version>` — Graphviz DOT. */
export async function graphExportCommand(
  versionKey: string,
  options: { out?: string; depth?: string },
): Promise<void> {
  const { config, client } = createContext();
  const version = await requireVersion(client, versionKey);

  const report = await blastRadius(client, version, traversalFrom(config, options.depth));
  const dot = renderDot(report);
  if (options.out) {
    writeFileSync(options.out, `${dot}\n`);
    process.stdout.write(`${green('wrote')} ${options.out}\n${dim('  render: dot -Tsvg -O ' + options.out)}\n`);
    return;
  }
  process.stdout.write(`${dot}\n`);
}

/**
 * `blastradius ci` — the gate.
 *
 * Exit 0 when clean, 1 when exposed above the threshold, 2 on an operational
 * failure. Distinguishing "found something" from "could not run" matters in a
 * pipeline: the first should fail the build, the second should page someone.
 */
export async function ciCommand(options: {
  repo?: string;
  failOn?: string;
  maxDepth?: string;
  since?: string;
  json?: boolean;
  sarif?: string;
  format?: string;
}): Promise<void> {
  const out = process.stdout;
  let context;
  try {
    context = createContext();
    await context.client.waitUntilReady(context.config.hydra.adminUrl, 20_000);
  } catch (error) {
    process.stderr.write(
      `blastradius ci: cannot reach HydraDB — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }

  const { config, client } = context;
  const threshold = options.failOn ? Number(options.failOn) : 1;
  const traversal = traversalFrom(config, options.maxDepth);

  const compromised = await listCompromisedVersions(client);
  const findings: Array<{ version: string; repo: string; depth: number; chain: string }> = [];

  for (const version of compromised) {
    const report = await blastRadius(client, version, traversal);
    for (const exposure of report.exposedRepos) {
      if (options.repo && exposure.repoName !== options.repo && exposure.repoKey !== options.repo) {
        continue;
      }
      findings.push({
        version: version.key,
        repo: exposure.repoName,
        depth: exposure.depth,
        chain: exposure.chainText,
      });
    }
  }

  // SARIF is what GitHub's code-scanning API ingests; writing it is what turns
  // the gate from an exit code into findings in the Security tab.
  if (options.sarif) {
    const sarif = renderSarif(
      findings.map((finding) => ({ ...finding, advisory: null, severity: null })),
      { toolVersion: '1.0.0' },
    );
    writeFileSync(options.sarif, `${JSON.stringify(sarif, null, 2)}\n`);
    out.write(dim(`wrote ${options.sarif} (${findings.length} result(s))\n`));
  }

  if (options.format === 'markdown') {
    // The shape a PR comment wants: a verdict line, then a table.
    out.write(`### Blast Radius — supply-chain gate\n\n`);
    if (findings.length === 0) {
      out.write(
        `**Pass.** ${compromised.length} compromised version(s) checked; nothing in this repository resolves any of them.\n`,
      );
    } else {
      out.write(
        `**Fail.** ${findings.length} exposure(s) across ${new Set(findings.map((f) => f.repo)).size} repositor(y/ies).\n\n`,
      );
      out.write('| repo | compromised version | depth | dependency chain |\n');
      out.write('|---|---|---|---|\n');
      for (const finding of findings) {
        out.write(
          `| \`${finding.repo}\` | \`${finding.version}\` | ${finding.depth} | \`${finding.chain}\` |\n`,
        );
      }
      out.write(
        `\n<sub>Run \`blastradius remediate <version>\` for the minimal change that clears these.</sub>\n`,
      );
    }
    process.exit(findings.length >= threshold ? 1 : 0);
  }

  if (options.json) {
    out.write(
      `${JSON.stringify({ compromisedVersions: compromised.length, findings, threshold }, null, 2)}\n`,
    );
  } else {
    out.write(`${bold('BLAST RADIUS CI GATE')}\n`);
    out.write(dim(`  ${compromised.length} compromised version(s) checked`));
    out.write(options.repo ? dim(` · scoped to ${options.repo}\n`) : '\n');
    if (findings.length === 0) {
      out.write(`\n  ${green('PASS')} — nothing exposed\n`);
    } else {
      out.write('\n');
      for (const finding of findings) {
        out.write(`  ${red('EXPOSED')} ${pad(finding.repo, 22)} ${dim(finding.chain)}\n`);
      }
      out.write(`\n  ${red('FAIL')} — ${findings.length} exposure(s), threshold ${threshold}\n`);
    }
  }

  process.exit(findings.length >= threshold ? 1 : 0);
}
