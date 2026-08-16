import { exposureDiff, findVersion } from '@blast/core';

import { createContext, fail, parseInstant } from '../context.js';
import { bold, cyan, dim, duration, green, iso, pad, red, yellow } from '../format.js';

export interface DiffOptions {
  from?: string;
  to?: string;
  verified?: boolean;
  json?: boolean;
}

/**
 * `blastradius diff <version> --from <ISO> --to <ISO>`
 *
 * What changed between two instants. The Time Machine says who was exposed at a
 * moment; this says what moved between two of them, which is the question asked
 * on the second morning of an incident.
 */
export async function diffCommand(versionKey: string, options: DiffOptions): Promise<void> {
  const { client } = createContext();

  const version = await findVersion(client, versionKey);
  if (!version) fail(`version not found in the graph: ${versionKey}`);

  // Default to the compromise window itself, which is the comparison that
  // answers "did we actually clean up after the incident".
  const from = options.from
    ? parseInstant(options.from, '--from')
    : (version.compromisedFrom ??
      fail(
        `${versionKey} has no compromise window, so there is no default to diff.\n` +
          '  Pass --from and --to explicitly, or mark a window first.',
      ));
  const to = options.to ? parseInstant(options.to, '--to') : Date.now();

  const report = await exposureDiff(client, version, from, to, {
    consistency: options.verified ? 'strong' : 'causal',
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`${bold('EXPOSURE DIFF')} — ${red(version.key)}\n`);
  out.write(dim(`  from ${iso(from)}\n`));
  out.write(dim(`  to   ${iso(to)}\n\n`));

  // A repository can hold several snapshots across the window, so the lockfile
  // shown is named for the side of the diff it was read from — otherwise a
  // capture timestamp later than `from` appears under "exposed at both" and
  // reads like a contradiction.
  const section = (
    title: string,
    colour: (text: string) => string,
    rows: typeof report.entered,
    side: string,
    note: string,
  ): void => {
    out.write(`${colour(bold(title))} ${dim(`(${rows.length})`)}\n`);
    if (rows.length === 0) {
      out.write(dim('  none\n\n'));
      return;
    }
    for (const row of rows) {
      out.write(`  ${colour(pad(row.repoName, 26))} ${dim(`${side} ${iso(row.capturedAt)}`)}\n`);
    }
    out.write(`${dim(`  ${note}`)}\n\n`);
  };

  section(
    'ENTERED EXPOSURE',
    red,
    report.entered,
    'lockfile at --to:',
    'clean at the start of the window, exposed at the end — a regression',
  );
  section(
    'CLEARED',
    green,
    report.cleared,
    'lockfile at --from:',
    'exposed at the start, clean at the end — remediation that landed',
  );
  section(
    'STILL EXPOSED',
    yellow,
    report.unchanged,
    'lockfile at --to:',
    'exposed at both instants — outstanding work',
  );

  if (report.untouched.length > 0) {
    out.write(`${dim(bold('PINNED IT AT SOME POINT, BUT AT NEITHER INSTANT'))} `);
    out.write(`${dim(`(${report.untouched.length})`)}\n`);
    out.write(dim(`  ${report.untouched.join(', ')}\n`));
    out.write(
      dim('  Not a change, but not unaffected either — they ran it outside this window.\n\n'),
    );
  }

  const net = report.entered.length - report.cleared.length;
  const verdict =
    net > 0
      ? red(`net +${net} exposed`)
      : net < 0
        ? green(`net ${net} exposed`)
        : dim('net zero change');
  out.write(`${bold('Net:')} ${verdict}\n`);
  out.write(`${bold('Query time:')} ${cyan(duration(report.elapsedMs))}  `);
  out.write(dim(`(one read, epoch ${report.readEpoch ?? 'n/a'} — both instants from one snapshot)\n`));
}
