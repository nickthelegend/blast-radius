import { clearCompromised, markManyCompromised, resolveAdvisory } from '@blast/core';

import { createContext, fail, parseInstant } from '../context.js';
import { bold, cyan, dim, duration, green, iso, red, yellow } from '../format.js';

export interface MarkAdvisoryOptions {
  from?: string;
  to?: string;
  clear?: boolean;
  json?: boolean;
}

/**
 * `blastradius mark-advisory <GHSA-…>` — arm a real disclosure.
 *
 * The demo's headline incident is a hand-marked six-minute window, which is the
 * right shape for a malicious publish. A CVE is the other shape entirely: every
 * affected version has been vulnerable since it shipped. This marks the whole
 * affected set from the graph's own `AFFECTS` edges, so the blast radius,
 * remediation and CI gate all work against a genuine disclosure rather than a
 * scenario someone typed in.
 */
export async function markAdvisoryCommand(
  advisoryId: string,
  options: MarkAdvisoryOptions,
): Promise<void> {
  const { client } = createContext();

  const from = options.from ? parseInstant(options.from, '--from') : undefined;
  const to = options.to ? parseInstant(options.to, '--to') : undefined;

  const arming = await resolveAdvisory(client, advisoryId, { from, to });
  if (!arming) {
    fail(
      `advisory not in the graph: ${advisoryId}\n` +
        'Run `blastradius advisories` for the 40 real OSV records that are loaded.',
    );
  }

  if (arming.versions.length === 0) {
    fail(
      `${arming.advisoryId} is in the graph but has no AFFECTS edges, so there is nothing to mark.`,
    );
  }

  const started = Date.now();

  if (options.clear) {
    await clearCompromised(
      client,
      arming.versions.map((version) => version.id),
    );
  } else {
    await markManyCompromised(
      client,
      arming.versions.map((version) => ({
        versionId: version.id,
        from: arming.from,
        to: arming.to,
        advisoryId: arming.advisoryId,
      })),
    );
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ...arming, cleared: options.clear === true }, null, 2)}\n`,
    );
    return;
  }

  const out = process.stdout;
  const severity =
    arming.severity === 'CRITICAL' || arming.severity === 'HIGH'
      ? red(arming.severity)
      : yellow(arming.severity);

  if (options.clear) {
    out.write(`${bold('CLEARED')} ${arming.advisoryId}\n`);
    out.write(dim(`  ${arming.versions.length} version(s) no longer marked compromised\n`));
    return;
  }

  out.write(`${bold('ARMED')} ${red(arming.advisoryId)}  ${severity}\n`);
  out.write(dim(`  ${arming.summary}\n\n`));
  out.write(`  ${bold('affected versions')}  ${arming.versions.length}\n`);
  out.write(`  ${bold('disclosed')}          ${iso(arming.published)}\n`);
  out.write(`  ${bold('window')}             ${iso(arming.from)} → ${iso(arming.to)}\n`);
  out.write(
    dim(
      '  A disclosure has no six-minute window: every affected version was\n' +
        '  vulnerable from publication until it is upgraded away from. Override\n' +
        '  with --from / --to.\n',
    ),
  );

  const shown = arming.versions.slice(0, 8);
  out.write(`\n  ${dim(shown.map((version) => version.key).join('\n  '))}\n`);
  if (arming.versions.length > shown.length) {
    out.write(dim(`  … and ${arming.versions.length - shown.length} more\n`));
  }

  out.write(`\n${bold('Marked in')} ${cyan(duration(Date.now() - started))}\n`);
  out.write(
    `\n${green('Next:')} blastradius exposure ${arming.versions[0]?.key ?? ''}\n` +
      `      blastradius ci --fail-on 1\n` +
      `      blastradius mark-advisory ${arming.advisoryId} --clear   ${dim('(undo)')}\n`,
  );
}
