import { findScenario, SCENARIOS, simulate, timeMachine, findVersion } from '@blast/core';

import { createContext, fail } from '../context.js';
import { bold, clock, cyan, dim, duration, green, magenta, pad, red, yellow } from '../format.js';
import { printReport } from './exposure.js';
import { printTimeMachine } from './timeMachine.js';

export interface SimulateOptions {
  scenario?: string;
  seed?: string;
  speed?: string;
  ticks?: string;
  json?: boolean;
  noReset?: boolean;
  timeMachine?: boolean;
}

export async function simulateCommand(options: SimulateOptions): Promise<void> {
  const { config, client } = createContext();

  const scenarioName = options.scenario ?? 'tanstack-worm-2026';
  const scenario = findScenario(scenarioName);
  if (!scenario) {
    fail(
      `unknown scenario: ${scenarioName}\n` +
        `Available: ${SCENARIOS.map((entry) => entry.name).join(', ')}`,
    );
  }

  const realDurationMs = options.speed ? Number(options.speed) * 1000 : 24_000;
  const ticks = options.ticks ? Number(options.ticks) : 12;
  const out = process.stdout;

  const events = simulate(client, {
    scenario,
    seedVersionKey: options.seed,
    realDurationMs,
    ticks,
    traversal: {
      maxDepth: config.traversal.maxDepth,
      pathCount: config.traversal.pathCount,
      resultLimit: config.traversal.resultLimit,
    },
    reset: !options.noReset,
    now: config.org.simulatedNow,
  });

  let seedKey = '';
  let peakRepos = 0;
  let windowFrom = 0;

  for await (const event of events) {
    if (options.json) {
      out.write(`${JSON.stringify(event)}\n`);
      if (event.type === 'error') process.exit(1);
      continue;
    }

    switch (event.type) {
      case 'start': {
        seedKey = event.seed.key;
        windowFrom = event.windowFrom;
        out.write(`${bold(`INCIDENT SIMULATION — ${event.scenario.title}`)}\n`);
        out.write(dim(`${event.scenario.description}\n\n`));
        out.write(dim(`Reference: ${event.scenario.reference}\n\n`));
        out.write(
          `${bold('Seed package:')}   ${magenta(event.seed.key)}\n` +
            `${bold('Live window:')}     ${clock(event.windowFrom)} → ${clock(event.windowTo)} ` +
            `(${event.scenario.windowMinutes} minutes)\n` +
            `${bold('Artifacts:')}       up to ${event.plannedArtifacts} malicious versions\n\n`,
        );
        out.write(
          dim(
            `Every measurement below is a live algo.SSpaths traversal against HydraDB.\n` +
              `${'-'.repeat(72)}\n`,
          ),
        );
        break;
      }

      case 'publish': {
        out.write(
          `${dim(`T+${offset(event.simulatedAt, windowFrom)}`)}  ${red('PUBLISH')}  ` +
            `${pad(event.versionKey, 38)} ${dim(`via ${event.viaMaintainer}`)}\n`,
        );
        break;
      }

      case 'measure': {
        peakRepos = Math.max(peakRepos, event.exposedRepoCount);
        const color =
          event.exposedRepoCount === 0 ? green : event.exposedRepoCount < 5 ? yellow : red;
        out.write(
          `${dim(`T+${offset(event.simulatedAt, windowFrom)}`)}  ${bold('EXPOSED')}  ` +
            `${color(`${pad(String(event.exposedRepoCount), 3)} repos`)}  ` +
            `${pad(`${event.exposedPackageCount} packages`, 16)} ` +
            `${dim(`${event.compromisedVersionCount} malicious versions live`)}  ` +
            `${cyan(duration(event.queryMs))}\n`,
        );
        break;
      }

      case 'done': {
        out.write(`${dim('-'.repeat(72))}\n\n`);
        printReport(event.report);
        out.write(
          `\n${bold('Simulation wall clock:')} ${cyan(duration(event.elapsedMs))}  ` +
            `${dim(`${event.compromisedVersionKeys.length} versions marked compromised`)}\n`,
        );
        break;
      }

      case 'error': {
        fail(event.message);
      }
    }
  }

  // The scenario is only half the story without the temporal view.
  if (options.timeMachine !== false && seedKey && !options.json) {
    const version = await findVersion(client, seedKey);
    if (version?.isCompromised) {
      out.write('\n');
      const report = await timeMachine(client, version, { verified: true });
      printTimeMachine(report);
    }
  }
}

/** Elapsed time inside the simulated incident window, as mm:ss. This is the
 *  "09:00 → 09:06" clock the track's framing is built around. */
function offset(simulatedAt: number, windowFrom: number): string {
  const seconds = Math.max(0, Math.round((simulatedAt - windowFrom) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function listScenariosCommand(): void {
  const out = process.stdout;
  out.write(`${bold('AVAILABLE SCENARIOS')}\n\n`);
  for (const scenario of SCENARIOS) {
    out.write(`  ${bold(scenario.name)}\n`);
    out.write(`    ${scenario.title}\n`);
    out.write(dim(`    window: ${scenario.windowMinutes} minutes, `));
    out.write(dim(`${scenario.artifactCount} artifacts, ${scenario.propagationTargets} targets\n`));
    out.write(dim(`    ${scenario.reference}\n\n`));
  }
}
