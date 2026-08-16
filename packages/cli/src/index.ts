#!/usr/bin/env node
/**
 * blastradius — supply-chain attack graph CLI, backed by HydraDB.
 */
import { Command } from 'commander';

import {
  armCommand,
  doctorCommand,
  incidentCommand,
  ingestCommand,
  loadCommand,
  markCompromisedCommand,
  resetCommand,
  statsCommand,
} from './commands/data.js';
import { exposureCommand } from './commands/exposure.js';
import {
  advisoriesCommand,
  ciCommand,
  graphExportCommand,
  maintainerRadiusCommand,
  preflightCommand,
  prioritiseCommand,
  reportCommand,
  sbomCommand,
  whyCommand,
} from './commands/insights.js';
import { inspectLockfileCommand, scanCommand } from './commands/scan.js';
import { maintainersCommand } from './commands/maintainers.js';
import { remediateCommand } from './commands/remediate.js';
import { serveCommand } from './commands/serve.js';
import { listScenariosCommand, simulateCommand } from './commands/simulate.js';
import { timeMachineCommand } from './commands/timeMachine.js';
import { typosquatsCommand } from './commands/typosquats.js';
import { HydraError } from '@blast/core';

const program = new Command();

program
  .name('blastradius')
  .description(
    'Live, queryable supply-chain attack graph on HydraDB.\n' +
      'Answers "a package was compromised at 09:00 — which services are exposed by 09:06?"',
  )
  .version('1.0.0');

program
  .command('mark-compromised')
  .description('mark a package version as compromised for a time window')
  .argument('<version>', 'ecosystem-qualified version key, e.g. npm:left-pad@3.4.1')
  .requiredOption('--from <instant>', 'ISO-8601 start of the compromise window')
  .requiredOption('--to <instant>', 'ISO-8601 end of the compromise window')
  .option('--advisory <id>', 'advisory identifier, e.g. GHSA-xxxx')
  .option('--clear', 'clear the marking instead of setting it')
  .action(markCompromisedCommand);

program
  .command('exposure')
  .description('full blast radius for a compromised version (algo.SSpaths)')
  .argument('<version>', 'ecosystem-qualified version key')
  .option('--repos <names>', 'comma-separated repos to check in one round trip (algo.MSpaths)')
  .option('--depth <n>', 'maximum dependency-chain depth')
  .option('--verified', 'read with strong consistency (pinned, refreshed snapshot)')
  .option('--pairwise', 'use MSpaths pairwise mode (see README: known engine defect)')
  .option('--which-version', 'also print the version timeline showing where the flaw entered')
  .option('--no-show-paths', 'omit dependency chains')
  .option('--json', 'emit JSON')
  .action(exposureCommand);

program
  .command('time-machine')
  .description('which lockfiles resolved the bad version while it was live')
  .argument('<version>', 'ecosystem-qualified version key')
  .option('--from <instant>', 'override the window start')
  .option('--to <instant>', 'override the window end')
  .option('--verified', 'read with strong consistency (pinned, refreshed snapshot)')
  .option('--no-compare', 'skip the "exposed now vs during window" comparison')
  .option('--json', 'emit JSON')
  .action(timeMachineCommand);

program
  .command('remediate')
  .description('what to change to clear the exposure — minimal dependency upgrades')
  .argument('<version>', 'compromised version key')
  .option('--depth <n>', 'maximum dependency-chain depth')
  .option('--verified', 'read with strong consistency')
  .option('--json', 'emit JSON')
  .action(remediateCommand);

program
  .command('prioritise')
  .alias('prioritize')
  .description('rank exposed repos by urgency (advisory severity x proximity x directness)')
  .argument('<version>', 'compromised version key')
  .option('--depth <n>', 'maximum dependency-chain depth')
  .option('--json', 'emit JSON')
  .action(prioritiseCommand);

program
  .command('preflight')
  .description('what a compromise WOULD cost, for the packages you depend on today')
  .option('--limit <n>', 'how many of the most-pinned versions to test', '15')
  .option('--json', 'emit JSON')
  .action(preflightCommand);

program
  .command('why')
  .description('the dependency chain that pulled a package into a repo (algo.SPpaths)')
  .argument('<repo>', 'repo name or key')
  .argument('<version>', 'version key to explain')
  .option('--depth <n>', 'maximum dependency-chain depth')
  .option('--json', 'emit JSON')
  .action(whyCommand);

program
  .command('maintainer-radius')
  .description('what burns if this maintainer account is compromised')
  .argument('<username>', 'maintainer username')
  .option('--json', 'emit JSON')
  .action(maintainerRadiusCommand);

program
  .command('advisories')
  .description('real OSV advisories in the graph and the repos they reach')
  .option('--json', 'emit JSON')
  .action(advisoriesCommand);

program
  .command('sbom')
  .description('export a repo\'s current lockfile as a CycloneDX 1.5 SBOM')
  .argument('<repo>', 'repo name or key')
  .option('--out <file>', 'write to a file instead of stdout')
  .action(sbomCommand);

program
  .command('report')
  .description('the whole incident as a Markdown report')
  .argument('<version>', 'compromised version key')
  .option('--out <file>', 'write to a file instead of stdout')
  .option('--depth <n>', 'maximum dependency-chain depth')
  .action(reportCommand);

program
  .command('graph-export')
  .description('export the blast radius as Graphviz DOT')
  .argument('<version>', 'compromised version key')
  .option('--out <file>', 'write to a file instead of stdout')
  .option('--depth <n>', 'maximum dependency-chain depth')
  .action(graphExportCommand);

program
  .command('ci')
  .description('CI gate: exit 1 if anything is exposed, 2 if the check could not run')
  .option('--repo <name>', 'scope the gate to one repository')
  .option('--fail-on <n>', 'number of exposures that constitutes a failure', '1')
  .option('--max-depth <n>', 'maximum dependency-chain depth')
  .option('--json', 'emit JSON')
  .action(ciCommand);

program
  .command('maintainers')
  .description('packages sharing a maintainer with this one, risk-scored')
  .argument('<package>', 'ecosystem-qualified package key, e.g. npm:left-pad')
  .option('--all', 'show every neighbour')
  .option('--limit <n>', 'neighbours to show', '20')
  .option('--json', 'emit JSON')
  .action(maintainersCommand);

program
  .command('typosquats')
  .description('packages whose names are suspiciously close to your dependencies')
  .option('--org <name>', 'organization name')
  .option('--all', 'show every finding')
  .option('--limit <n>', 'findings to show', '25')
  .option('--json', 'emit JSON')
  .action(typosquatsCommand);

program
  .command('simulate')
  .description('replay an incident against the live graph with an attack clock')
  .option('--scenario <name>', 'scenario name', 'tanstack-worm-2026')
  .option('--seed <version>', 'seed the compromise on a specific version')
  .option('--speed <seconds>', 'wall-clock seconds to compress the window into', '24')
  .option('--ticks <n>', 'measurement ticks', '12')
  .option('--no-reset', 'keep existing compromise markings')
  .option('--no-time-machine', 'skip the Time Machine report at the end')
  .option('--json', 'emit newline-delimited JSON events')
  .action(simulateCommand);

program.command('scenarios').description('list available incident scenarios').action(listScenariosCommand);

program
  .command('load')
  .description('load the vendored graph snapshot into HydraDB (batched UNWIND)')
  .option('--reset', 'clear the graph first')
  .option('--chunk <n>', 'rows per write round trip', '500')
  .action(loadCommand);

program
  .command('ingest')
  .description('rebuild the graph snapshot from the live npm registry and OSV.dev')
  .action(ingestCommand);

program.command('reset').description('delete every Blast Radius node from HydraDB').action(resetCommand);

program
  .command('incident')
  .description('show the demo incident recorded in the snapshot')
  .option('--key', 'print only the compromised version key')
  .option('--json', 'emit JSON')
  .action(incidentCommand);

program
  .command('arm')
  .description('mark the recorded demo incident compromised')
  .action(armCommand);

program
  .command('stats')
  .description('what is currently in the graph')
  .option('--json', 'emit JSON')
  .action(statsCommand);

program
  .command('doctor')
  .description('check HydraDB connectivity and verify every engine capability used')
  .option('--bolt', 'additionally verify the Neo4j-compatible Bolt endpoint')
  .action(doctorCommand);

program
  .command('scan')
  .description("scan a real repository's lockfile into the graph")
  .argument('[directory]', 'repository to scan', '.')
  .option('--org <name>', 'organization to file it under')
  .option('--name <name>', 'repo name (defaults to package.json name)')
  .option('--at <instant>', 'override the capture instant (defaults to lockfile mtime)')
  .option('--json', 'emit JSON')
  .action(scanCommand);

program
  .command('inspect-lockfile')
  .description('parse a lockfile and report what is in it, without writing to the graph')
  .argument('[directory]', 'repository to inspect', '.')
  .action(inspectLockfileCommand);

program
  .command('serve')
  .description('run the dashboard API server')
  .option('--port <n>', 'port to listen on')
  .action(serveCommand);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof HydraError) {
      process.stderr.write(`\n${error.message}\n`);
      if (error.status !== null && error.status < 500) {
        process.stderr.write(`\nQuery:\n${error.query}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

void main();
