import { findPackage, maintainerWeb, type MaintainerWebReport } from '@blast/core';

import { createContext, fail } from '../context.js';
import { bold, cyan, dim, duration, green, pad, red, yellow } from '../format.js';

export interface MaintainersOptions {
  json?: boolean;
  all?: boolean;
  limit?: string;
}

export async function maintainersCommand(
  packageKey: string,
  options: MaintainersOptions,
): Promise<void> {
  const { config, client } = createContext();

  const pkg = await findPackage(client, packageKey);
  if (!pkg) {
    fail(
      `package not found in the graph: ${packageKey}\n` +
        `Package keys are ecosystem-qualified, e.g. "npm:left-pad".`,
    );
  }

  const report = await maintainerWeb(client, pkg, {
    pathCount: config.traversal.pathCount,
    resultLimit: config.traversal.resultLimit,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printMaintainerWeb(report, {
    all: options.all ?? false,
    limit: options.limit ? Number(options.limit) : 20,
  });
}

export function printMaintainerWeb(
  report: MaintainerWebReport,
  options: { all: boolean; limit: number },
): void {
  const out = process.stdout;
  out.write(`${bold(`SHARED-MAINTAINER RISK for ${report.package.key}`)}\n`);

  if (report.maintainers.length === 0) {
    out.write(dim('  no maintainer metadata for this package in the graph\n'));
    out.write(
      dim('  (maintainers come from full packuments, fetched to INGEST_FULL_METADATA_DEPTH)\n'),
    );
    return;
  }

  out.write(
    dim(
      `  maintainers: ${report.maintainers.map((maintainer) => maintainer.username).join(', ')}\n\n`,
    ),
  );

  const shown = options.all ? report.neighbors : report.neighbors.slice(0, options.limit);

  if (shown.length === 0) {
    out.write(dim('  no other package in the graph shares a maintainer with this one\n'));
  }

  for (const neighbor of shown) {
    const marker = neighbor.isOrgDependency ? red(' — you depend on this too') : '';
    const via = neighbor.sharedMaintainers.map((name) => `"${name}"`).join(', ');
    out.write(`  ${pad(neighbor.packageKey, 34)} shares maintainer ${via}${marker}\n`);
  }

  if (!options.all && report.neighbors.length > shown.length) {
    out.write(dim(`  … and ${report.neighbors.length - shown.length} more (use --all)\n`));
  }

  const color =
    report.riskLevel === 'HIGH' ? red : report.riskLevel === 'MEDIUM' ? yellow : green;
  out.write(`\n${bold('Risk score:')} ${color(report.riskLevel)} ${dim(`(${report.riskReason})`)}\n`);
  out.write(
    `${bold('Query time:')} ${cyan(duration(report.elapsedMs))}  ` +
      `${dim("(algo.SSpaths over MAINTAINS, relDirection='both', maxLen=2)")}\n`,
  );
}
