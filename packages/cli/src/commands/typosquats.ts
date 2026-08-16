import { typosquats, type TyposquatFinding } from '@blast/core';

import { createContext } from '../context.js';
import { bold, cyan, dim, duration, green, iso, pad, red, yellow } from '../format.js';

export interface TyposquatOptions {
  org?: string;
  json?: boolean;
  all?: boolean;
  limit?: string;
}

export async function typosquatsCommand(options: TyposquatOptions): Promise<void> {
  const { config, client } = createContext();

  const result = await typosquats(client, {
    recentDays: config.typosquat.recentDays,
    lowDownloadThreshold: config.typosquat.lowDownloadThreshold,
    now: Date.now(),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const limit = options.limit ? Number(options.limit) : 25;
  printTyposquats(result.findings, result.elapsedMs, {
    org: options.org ?? config.org.name,
    all: options.all ?? false,
    limit,
  });
}

export function printTyposquats(
  findings: TyposquatFinding[],
  elapsedMs: number,
  options: { org: string; all: boolean; limit: number },
): void {
  const out = process.stdout;
  out.write(`${bold(`POSSIBLE TYPOSQUATS of your top dependencies`)} ${dim(`(org: ${options.org})`)}\n`);

  if (findings.length === 0) {
    out.write(
      `  ${green('none')} — no package in the graph is within the configured edit distance ` +
        `of a trusted dependency\n`,
    );
    return;
  }

  const shown = options.all ? findings : findings.slice(0, options.limit);

  for (const finding of shown) {
    const verdictColor =
      finding.verdict === 'SUSPICIOUS' ? red : finding.verdict === 'WATCH' ? yellow : green;
    const pair = `"${finding.trustedName}" vs "${finding.candidateName}"`;
    out.write(`  ${pad(pair, 40)} ${dim(`(edit distance ${finding.distance})`)}\n`);
    out.write(
      `  ${' '.repeat(40)} ${finding.rationale} — ${verdictColor(finding.verdict)}\n`,
    );
    out.write(`  ${' '.repeat(40)} ${dim(finding.reason)}\n`);
    if (finding.candidateCreatedAt > 0) {
      out.write(`  ${' '.repeat(40)} ${dim(`first published ${iso(finding.candidateCreatedAt)}`)}\n`);
    }
    out.write('\n');
  }

  if (!options.all && findings.length > shown.length) {
    out.write(dim(`  … and ${findings.length - shown.length} more (use --all)\n\n`));
  }

  const suspicious = findings.filter((finding) => finding.verdict === 'SUSPICIOUS').length;
  const watch = findings.filter((finding) => finding.verdict === 'WATCH').length;
  const legit = findings.filter((finding) => finding.verdict === 'LIKELY_LEGITIMATE').length;
  out.write(
    `${bold('Summary:')} ${red(`${suspicious} suspicious`)}, ${yellow(`${watch} watch`)}, ` +
      `${green(`${legit} likely legitimate`)}\n`,
  );
  out.write(
    `${bold('Query time:')} ${cyan(duration(elapsedMs))}  ` +
      `${dim('(NAME_SIMILAR_TO edges, precomputed at load)')}\n`,
  );
}
