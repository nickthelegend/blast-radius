import { blastRadius, findVersion, planRemediation, type RemediationPlan } from '@blast/core';

import { createContext, fail } from '../context.js';
import { bold, cyan, dim, duration, green, pad, red, yellow } from '../format.js';

export interface RemediateOptions {
  depth?: string;
  json?: boolean;
  verified?: boolean;
}

export async function remediateCommand(
  versionKey: string,
  options: RemediateOptions,
): Promise<void> {
  const { config, client } = createContext();

  const source = await findVersion(client, versionKey);
  if (!source) fail(`version not found in the graph: ${versionKey}`);

  const maxDepth = options.depth ? Number(options.depth) : config.traversal.maxDepth;
  const traversal = {
    maxDepth,
    pathCount: config.traversal.pathCount,
    resultLimit: config.traversal.resultLimit,
    consistency: options.verified
      ? config.traversal.verifiedConsistency
      : config.traversal.readConsistency,
  };

  const report = await blastRadius(client, source, traversal);
  const plan = await planRemediation(client, report, traversal);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  printPlan(plan);
}

export function printPlan(plan: RemediationPlan): void {
  const out = process.stdout;
  out.write(`${bold(`REMEDIATION PLAN — ${plan.source.key}`)}\n`);

  if (plan.fixes.length === 0) {
    out.write(`  ${green('nothing to do')} — no repository is currently exposed\n`);
    return;
  }

  out.write(
    dim(
      `  ${plan.reposExposed} exposed, ${plan.reposFixable} fixable by a dependency change\n` +
        `  ${plan.candidatesTested} candidate versions tested against the graph\n\n`,
    ),
  );

  if (plan.distinctChanges.length > 0) {
    out.write(`${bold('Do this')}\n`);
    for (const change of plan.distinctChanges) {
      const label =
        change.direction === 'rollback' ? yellow('roll back') : green('upgrade  ');
      out.write(
        `  ${label} ${bold(`${change.packageName}@${change.to}`)}  ` +
          dim(`(from ${change.from.join(', ')})`) +
          '\n' +
          `    ${dim(`clears: ${change.repos.join(', ')}`)}\n`,
      );
    }
    out.write('\n');
  }

  out.write(`${bold('Per repository')}\n`);
  for (const fix of plan.fixes) {
    const head = `  ${pad(fix.repoName, 24)}`;
    if (fix.targetVersion === null) {
      out.write(`${head} ${red('no safe version')}\n`);
      out.write(`  ${' '.repeat(24)} ${dim(fix.explanation)}\n`);
      continue;
    }
    const major = fix.isMajorBump
      ? yellow(`  crosses a major version — check for breaking changes`)
      : '';
    const arrow = fix.direction === 'rollback' ? yellow('↓') : green('↑');
    out.write(
      `${head} ${fix.packageName} ${red(fix.currentVersion)} ${arrow} ` +
        `${green(fix.targetVersion)}${major}\n`,
    );
    out.write(`  ${' '.repeat(24)} ${dim(fix.chainText)}\n`);
  }

  const unfixable = plan.fixes.filter((fix) => fix.targetVersion === null);
  if (unfixable.length > 0) {
    out.write(
      `\n${yellow('!')} ${unfixable.length} ${unfixable.length === 1 ? 'repository has' : 'repositories have'} ` +
        `no safe version available. Those need an upstream fix or a dropped dependency.\n`,
    );
  }

  const rollbacks = plan.fixes.filter((fix) => fix.direction === 'rollback').length;
  if (rollbacks > 0) {
    out.write(
      dim(
        `\n${rollbacks} of these are rollbacks rather than upgrades — no newer release in the ` +
          `graph avoids the compromised version. Rolling back is a normal response to a live ` +
          `compromise, but it is labelled as such rather than dressed up as an upgrade.\n`,
      ),
    );
  }

  out.write(
    `\n${bold('Query time:')} ${cyan(duration(plan.elapsedMs))}  ` +
      `${dim('(algo.MSpaths — every candidate version tested against the graph at once)')}\n`,
  );
}
