import {
  applySchema,
  clearCompromised,
  findVersion,
  graphStats,
  listCompromisedVersions,
  listRepos,
  loadSnapshot,
  markCompromised,
  readSchemaVersion,
  readSnapshot,
  resetGraph,
  runIngest,
  SCHEMA_VERSION,
  snapshotExists,
  verifyEngineCapabilities,
} from '@blast/core';

import { createContext, fail, parseInstant } from '../context.js';
import { bold, cyan, dim, duration, green, iso, pad, red, yellow } from '../format.js';

export async function loadCommand(options: { reset?: boolean; chunk?: string }): Promise<void> {
  const { config, client, ids, idMapPath } = createContext();
  const out = process.stdout;

  if (!snapshotExists(config.paths.snapshot)) {
    fail(
      `no graph snapshot found at ${config.paths.snapshot}.\n` +
        `Run \`make ingest\` to build one from the live npm registry.`,
    );
  }

  out.write(dim(`waiting for HydraDB at ${config.hydra.adminUrl}\n`));
  await client.waitUntilReady(config.hydra.adminUrl);

  if (options.reset) {
    out.write(dim('clearing existing graph…\n'));
    const deleted = await resetGraph(client);
    out.write(dim(`  removed ${deleted} nodes\n`));
  }

  await applySchema(client);
  const snapshot = readSnapshot(config.paths.snapshot);

  out.write(`${bold('Loading graph into HydraDB')} ${dim('(batched UNWIND writes)')}\n`);
  const startedAt = Date.now();
  let lastLabel = '';

  const stats = await loadSnapshot(client, snapshot, ids, {
    chunkSize: options.chunk ? Number(options.chunk) : 500,
    onStage: (label, done, total) => {
      if (label !== lastLabel) {
        lastLabel = label;
        out.write(`  ${pad(label, 18)}`);
      }
      if (process.stdout.isTTY) {
        out.write(`\r  ${pad(label, 18)} ${done}/${total}`);
      }
      if (done === total) out.write(`\r  ${pad(label, 18)} ${green(String(total))}\n`);
    },
    onDuplicate: (label, dropped) => {
      out.write(dim(`  ${pad(label, 18)} dropped ${dropped} duplicate relationship ids\n`));
    },
  });

  ids.save(idMapPath);

  const totalRequests = stats.reduce((sum, stat) => sum + stat.requests, 0);
  const totalRows = stats.reduce((sum, stat) => sum + stat.count, 0);
  out.write(
    `\n${bold('Loaded')} ${green(String(totalRows))} rows in ${cyan(String(totalRequests))} ` +
      `round trips, ${cyan(duration(Date.now() - startedAt))}\n`,
  );
  out.write(dim(`id map written to ${idMapPath}\n`));
}

export async function ingestCommand(): Promise<void> {
  const { config } = createContext();
  const startedAt = Date.now();
  const snapshot = await runIngest({
    config,
    onLog: (message) => process.stdout.write(`${dim('[ingest]')} ${message}\n`),
  });
  process.stdout.write(
    `\n${bold('Ingest complete')} in ${cyan(duration(Date.now() - startedAt))}\n` +
      `  packages ${snapshot.packages.length}, versions ${snapshot.versions.length}, ` +
      `resolved edges ${snapshot.resolved_to.length}\n`,
  );
}

export async function resetCommand(): Promise<void> {
  const { client } = createContext();
  process.stdout.write(dim('deleting nodes (DETACH DELETE is slow on high-degree nodes)…\n'));
  const deleted = await resetGraph(client, {
    onProgress: (label, count) => {
      if (process.stdout.isTTY) process.stdout.write(`\r  ${pad(label, 20)} ${count}`);
    },
  });
  process.stdout.write(`\nremoved ${deleted} nodes\n`);
}

/**
 * Print the incident recorded in the snapshot. The seeded package depends on
 * what the crawl actually returned, so the Makefile and the README examples
 * read it from here rather than hard-coding a name that would drift.
 */
export async function incidentCommand(options: {
  key?: boolean;
  json?: boolean;
}): Promise<void> {
  const { config } = createContext();
  const snapshot = readSnapshot(config.paths.snapshot);
  const incident = snapshot.incident;

  if (!incident) {
    fail('this snapshot records no incident seed. Re-run `make ingest`.');
  }
  if (options.key) {
    process.stdout.write(`${incident.version_key}\n`);
    return;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(incident, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${bold('DEMO INCIDENT')} ${dim(`(recorded at ingest time)`)}\n` +
      `  ${pad('scenario', 20)} ${incident.scenario}\n` +
      `  ${pad('compromised', 20)} ${red(incident.version_key)}\n` +
      `  ${pad('safe version', 20)} ${green(incident.replacement_version_key)}\n` +
      `  ${pad('window', 20)} ${iso(incident.from)} → ${iso(incident.to)}\n`,
  );
}

/** Mark the recorded demo incident compromised. Used by `make demo`. */
export async function armCommand(): Promise<void> {
  const { config, client } = createContext();
  const snapshot = readSnapshot(config.paths.snapshot);
  const incident = snapshot.incident;
  if (!incident) fail('this snapshot records no incident seed. Re-run `make ingest`.');

  const version = await findVersion(client, incident.version_key);
  if (!version) {
    fail(
      `the recorded incident version ${incident.version_key} is not in the graph.\n` +
        `Run \`blastradius load\` first.`,
    );
  }

  // Clear first: a previous `simulate` run leaves its propagated versions
  // marked, and those would otherwise show up alongside the demo incident.
  const existing = await listCompromisedVersions(client);
  if (existing.length > 0) {
    await clearCompromised(
      client,
      existing.map((entry) => entry.id),
    );
  }

  await markCompromised(client, version.id, incident.from, incident.to, 'BLAST-DEMO-2026-0001');
  process.stdout.write(
    `${red('marked compromised')} ${bold(incident.version_key)}  ` +
      dim(`${iso(incident.from)} → ${iso(incident.to)}\n`),
  );
}

export async function statsCommand(options: { json?: boolean }): Promise<void> {
  const { config, client } = createContext();
  const stats = await graphStats(client);
  const compromised = await listCompromisedVersions(client);
  const repos = await listRepos(client, config.org.name);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ stats, compromised, repos }, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`${bold('GRAPH CONTENTS')} ${dim(`(${config.hydra.httpUrl})`)}\n`);
  const rows: Array<[string, number]> = [
    ['Package', stats.packages],
    ['Version', stats.versions],
    ['Maintainer', stats.maintainers],
    ['Repo', stats.repos],
    ['LockfileSnapshot', stats.snapshots],
    ['RESOLVED_TO edges', stats.resolvedToEdges],
    ['RESOLVED edges', stats.resolvedEdges],
    ['MAINTAINS edges', stats.maintainsEdges],
    ['NAME_SIMILAR_TO edges', stats.similarEdges],
  ];
  for (const [label, value] of rows) {
    out.write(`  ${pad(label, 24)} ${value.toLocaleString()}\n`);
  }

  out.write(`\n${bold('Repos')} ${dim(`(org: ${config.org.name})`)}\n`);
  out.write(`  ${repos.map((repo) => repo.name).join(', ')}\n`);

  out.write(`\n${bold('Compromised versions')}\n`);
  if (compromised.length === 0) {
    out.write(dim('  none marked\n'));
  }
  for (const version of compromised) {
    out.write(
      `  ${red(pad(version.key, 34))} ${iso(version.compromisedFrom)} → ${iso(version.compromisedTo)}\n`,
    );
  }
}

export async function markCompromisedCommand(
  versionKey: string,
  options: { from: string; to: string; advisory?: string; clear?: boolean },
): Promise<void> {
  const { client } = createContext();

  const version = await findVersion(client, versionKey);
  if (!version) fail(`version not found in the graph: ${versionKey}`);

  if (options.clear) {
    await clearCompromised(client, [version.id]);
    process.stdout.write(`${green('cleared')} compromise marking on ${versionKey}\n`);
    return;
  }

  if (!options.from || !options.to) {
    fail('both --from and --to are required (ISO-8601 instants)');
  }

  const from = parseInstant(options.from, '--from');
  const to = parseInstant(options.to, '--to');
  if (to < from) fail(`--to (${options.to}) is before --from (${options.from})`);

  await markCompromised(client, version.id, from, to, options.advisory ?? '');

  process.stdout.write(
    `${red('marked compromised')} ${bold(versionKey)}\n` +
      `  window ${iso(from)} → ${iso(to)} ` +
      dim(`(${Math.round((to - from) / 1000)}s)`) +
      '\n' +
      (options.advisory ? dim(`  advisory ${options.advisory}\n`) : '') +
      dim(`\nNext: blastradius exposure ${versionKey}\n`) +
      dim(`      blastradius time-machine ${versionKey}\n`),
  );
}

export async function doctorCommand(): Promise<void> {
  const { config, client } = createContext();
  const out = process.stdout;

  out.write(`${bold('BLAST RADIUS DOCTOR')}\n\n`);
  out.write(`${bold('Configuration')}\n`);
  out.write(`  ${pad('HydraDB HTTP', 22)} ${config.hydra.httpUrl}\n`);
  out.write(`  ${pad('HydraDB Bolt', 22)} ${config.hydra.boltUrl}\n`);
  out.write(`  ${pad('admin', 22)} ${config.hydra.adminUrl}\n`);
  out.write(`  ${pad('graph', 22)} ${config.hydra.namespace}/${config.hydra.graphId}/${config.hydra.cellId}\n`);
  out.write(`  ${pad('max depth', 22)} ${config.traversal.maxDepth}\n`);
  out.write(`  ${pad('path budget', 22)} ${config.traversal.pathCount}\n`);
  out.write(`  ${pad('snapshot', 22)} ${config.paths.snapshot}\n\n`);

  const ready = await client.ready(config.hydra.adminUrl);
  out.write(`${bold('Readiness')}\n`);
  out.write(`  ${pad('/readyz', 22)} ${ready ? green('200 OK') : red('unreachable')}\n`);
  if (!ready) {
    out.write(
      yellow(`\nHydraDB is not answering. Start it with:\n  make db-up\n`),
    );
    process.exit(1);
  }

  const schema = await readSchemaVersion(client);
  out.write(
    `  ${pad('schema version', 22)} ` +
      (schema === null
        ? yellow('not applied — run `blastradius load`')
        : schema === SCHEMA_VERSION
          ? green(String(schema))
          : yellow(`${schema} (expected ${SCHEMA_VERSION})`)) +
      '\n\n',
  );

  out.write(`${bold('Engine capability checks')} ${dim('(run against a scratch id range)')}\n`);
  const checks = await verifyEngineCapabilities(client);
  for (const check of checks) {
    const mark = check.ok ? green('ok  ') : red('FAIL');
    out.write(`  ${mark} ${pad(check.name, 40)} ${dim(check.detail)}\n`);
  }

  const failed = checks.filter((check) => !check.ok);
  out.write('\n');
  if (failed.length > 0) {
    out.write(red(`${failed.length} capability check(s) failed.\n`));
    process.exit(1);
  }
  out.write(green('All engine capabilities Blast Radius depends on are present.\n'));

  const stats = await graphStats(client);
  if (stats.versions === 0) {
    out.write(yellow('\nThe graph is empty. Load it with `make demo`.\n'));
  } else {
    out.write(
      dim(
        `\nGraph: ${stats.packages.toLocaleString()} packages, ` +
          `${stats.versions.toLocaleString()} versions, ` +
          `${stats.resolvedToEdges.toLocaleString()} resolved edges.\n`,
      ),
    );
  }
}
