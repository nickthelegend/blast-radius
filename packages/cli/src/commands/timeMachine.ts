import { blastRadius, findVersion, timeMachine, type TimeMachineReport } from '@blast/core';

import { createContext, fail, parseInstant, requireVersion } from '../context.js';
import {
  bold,
  clock,
  cyan,
  dim,
  duration,
  green,
  iso,
  pad,
  red,
  windowLabel,
  yellow,
} from '../format.js';

export interface TimeMachineOptions {
  from?: string;
  to?: string;
  verified?: boolean;
  json?: boolean;
  compare?: boolean;
}

export async function timeMachineCommand(
  versionKey: string,
  options: TimeMachineOptions,
): Promise<void> {
  const { config, client } = createContext();

  const version = await requireVersion(client, versionKey);

  const from = options.from ? parseInstant(options.from, '--from') : undefined;
  const to = options.to ? parseInstant(options.to, '--to') : undefined;

  let report: TimeMachineReport;
  try {
    report = await timeMachine(client, version, { from, to, verified: options.verified ?? false });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printTimeMachine(report);

  // The side-by-side comparison is the whole point of a temporal graph, so it
  // is on by default rather than hidden behind a flag.
  if (options.compare !== false) {
    const live = await blastRadius(client, version, {
      maxDepth: config.traversal.maxDepth,
      pathCount: config.traversal.pathCount,
      resultLimit: config.traversal.resultLimit,
    });
    printComparison(report, live.exposedRepos.map((exposure) => exposure.repoName));
  }
}

export function printTimeMachine(report: TimeMachineReport): void {
  const out = process.stdout;
  out.write(
    `${bold(`LOCKFILE TIME MACHINE — exposure window ${windowLabel(report.windowFrom, report.windowTo)}`)}\n`,
  );
  out.write(dim(`package: ${report.version.key}\n`));

  out.write(`\n${bold('Snapshots resolved to the bad version DURING the window:')}\n`);
  if (report.duringWindow.length === 0) {
    out.write(`  ${green('none')}\n`);
  }
  for (const exposure of report.duringWindow) {
    out.write(
      `  repo: ${pad(exposure.repoName, 24)} lockfile captured ${clock(exposure.capturedAt)}  ` +
        `${red('← EXPOSED DURING WINDOW')}${exposure.direct ? yellow('  (direct)') : ''}\n`,
    );
  }

  if (report.supersededSinceWindow.length > 0) {
    out.write(
      `\n${bold('Snapshots that have since upgraded past the bad version')}\n` +
        dim('(no longer live-exposed, but WERE exposed during the incident — still worth a security review):\n'),
    );
    for (const exposure of report.supersededSinceWindow) {
      out.write(
        `  repo: ${pad(exposure.repoName, 24)} captured ${clock(exposure.capturedAt)}, ` +
          `superseded ${clock(exposure.supersededAt)}\n`,
      );
    }
  }

  if (report.stillCurrent.length > 0) {
    out.write(`\n${bold('Still pinned to the bad version right now:')}\n`);
    for (const exposure of report.stillCurrent) {
      out.write(
        `  repo: ${pad(exposure.repoName, 24)} captured ${clock(exposure.capturedAt)}  ` +
          `${red('← STILL EXPOSED')}\n`,
      );
    }
  }

  if (report.outsideWindow.length > 0) {
    out.write(
      `\n${dim('Pinned this version outside the compromise window (not exposed to the malicious build):')}\n`,
    );
    for (const exposure of report.outsideWindow.slice(0, 10)) {
      out.write(`  ${dim(`repo: ${pad(exposure.repoName, 24)} captured ${iso(exposure.capturedAt)}`)}\n`);
    }
    if (report.outsideWindow.length > 10) {
      out.write(dim(`  … and ${report.outsideWindow.length - 10} more\n`));
    }
  }

  const mode = report.verified
    ? `${report.consistency} consistency, pinned snapshot, verified`
    : `${report.consistency} consistency, pinned snapshot`;
  out.write(`\n${bold('Query time:')} ${cyan(duration(report.elapsedMs))}  ${dim(`(${mode})`)}\n`);
  if (report.readEpoch !== null) out.write(dim(`Read epoch: ${report.readEpoch}\n`));
}

/**
 * The distinction that makes the temporal graph worth having: a repo can be
 * exposed now, exposed only historically, or both — and a flat scanner can only
 * ever see the first.
 */
export function printComparison(report: TimeMachineReport, exposedNow: string[]): void {
  const out = process.stdout;
  const duringNames = new Set(report.duringWindow.map((exposure) => exposure.repoName));
  const nowNames = new Set(exposedNow);
  const all = [...new Set([...duringNames, ...nowNames])].sort();

  out.write(`\n${bold('EXPOSED NOW  vs  EXPOSED DURING THE WINDOW')}\n`);
  out.write(dim(`${pad('repo', 26)}${pad('exposed now', 16)}during window\n`));
  out.write(dim(`${'-'.repeat(58)}\n`));

  // Pad the plain text first, then colorize: ANSI escapes are zero-width on
  // screen but count towards string length, so padding a coloured string
  // misaligns every row.
  const cell = (value: boolean, width: number): string => {
    const text = value ? 'yes' : 'no';
    return (value ? red(text) : green(text)) + ' '.repeat(Math.max(0, width - text.length));
  };

  for (const name of all) {
    out.write(
      `${pad(name, 26)}${cell(nowNames.has(name), 16)}${cell(duringNames.has(name), 0)}\n`,
    );
  }

  const onlyHistorical = [...duringNames].filter((name) => !nowNames.has(name));
  const onlyNow = [...nowNames].filter((name) => !duringNames.has(name));

  out.write('\n');
  if (onlyHistorical.length > 0) {
    out.write(
      `${yellow('!')} ${onlyHistorical.length} ${onlyHistorical.length === 1 ? 'repo was' : 'repos were'} ` +
        `exposed during the incident but ${onlyHistorical.length === 1 ? 'is' : 'are'} clean now: ` +
        `${onlyHistorical.join(', ')}\n` +
        dim('  A scanner that only reads current lockfiles reports these as safe. They ran the malicious build.\n'),
    );
  }
  if (onlyNow.length > 0) {
    out.write(
      `${yellow('!')} ${onlyNow.length} ${onlyNow.length === 1 ? 'repo is' : 'repos are'} exposed now but ` +
        `did not resolve the bad version during the window: ${onlyNow.join(', ')}\n` +
        dim('  These picked the version up after the artifacts were pulled.\n'),
    );
  }
  if (onlyHistorical.length === 0 && onlyNow.length === 0) {
    out.write(dim('  The two sets agree for this incident.\n'));
  }
}
