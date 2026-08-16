import { resolve } from 'node:path';

import { blastRadius, findVersion, listCompromisedVersions, scanRepository } from '@blast/core';

import { createContext, fail, parseInstant } from '../context.js';
import { bold, cyan, dim, duration, green, iso, pad, red, yellow } from '../format.js';

export interface ScanOptions {
  org?: string;
  name?: string;
  at?: string;
  json?: boolean;
  exposure?: boolean;
}

/**
 * Scan a real repository's lockfile into the graph.
 *
 * This is the command that makes the whole tool concrete: point it at any
 * JavaScript repository and its actual dependency tree becomes queryable
 * alongside the crawled ecosystem graph.
 */
export async function scanCommand(directory: string | undefined, options: ScanOptions): Promise<void> {
  const { config, client, ids, idMapPath } = createContext();
  const out = process.stdout;
  const target = resolve(directory ?? process.cwd());

  await client.waitUntilReady(config.hydra.adminUrl);

  let result;
  try {
    result = await scanRepository(client, ids, {
      directory: target,
      orgKey: options.org ?? config.org.name,
      repoName: options.name,
      capturedAt: options.at ? parseInstant(options.at, '--at') : undefined,
      onLog: (message) => {
        if (!options.json) out.write(`${dim('[scan]')} ${message}\n`);
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  ids.save(idMapPath);

  if (options.json) {
    out.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  out.write(`\n${bold(`SCANNED — ${result.repoKey}`)}\n`);
  out.write(`  ${pad('lockfile', 22)} ${result.lockfile}\n`);
  out.write(`  ${pad('format', 22)} ${result.lockfileKind}\n`);
  out.write(`  ${pad('captured at', 22)} ${iso(result.capturedAt)} ${dim('(lockfile mtime)')}\n`);
  out.write(`  ${pad('packages pinned', 22)} ${result.resolvedEdges}\n`);
  out.write(`  ${pad('direct dependencies', 22)} ${result.directDependencies}\n`);
  out.write(`  ${pad('resolution edges', 22)} ${result.resolvedToEdges} ${dim("(npm's own hoisting)")}\n`);
  out.write(
    `  ${pad('already in graph', 22)} ${green(String(result.versionsAlreadyKnown))} ` +
      dim(`of ${result.versionsAlreadyKnown + result.versionsWritten} versions`) +
      '\n',
  );
  out.write(`  ${pad('new to the graph', 22)} ${result.versionsWritten}\n`);
  if (result.supersededSnapshotKey) {
    out.write(
      `  ${pad('supersedes', 22)} ${dim(result.supersededSnapshotKey)}\n` +
        dim(`  ${' '.repeat(22)} this repo now has real lockfile history\n`),
    );
  }
  out.write(`  ${pad('elapsed', 22)} ${cyan(duration(result.elapsedMs))}\n`);

  // Immediately answer the question the scan exists to answer.
  const compromised = await listCompromisedVersions(client);
  if (compromised.length === 0) {
    out.write(
      dim(
        `\nNothing is marked compromised yet. Try:\n` +
          `  blastradius arm\n` +
          `  blastradius exposure <version> --repos ${result.repoName}\n`,
      ),
    );
    return;
  }

  out.write(`\n${bold('Checking this repo against every compromised version…')}\n`);
  let anyExposure = false;

  for (const version of compromised) {
    const source = await findVersion(client, version.key);
    if (!source) continue;
    const report = await blastRadius(client, source, {
      maxDepth: config.traversal.maxDepth,
      pathCount: config.traversal.pathCount,
      resultLimit: config.traversal.resultLimit,
    });
    const hit = report.exposedRepos.find((exposure) => exposure.repoKey === result.repoKey);
    if (!hit) continue;
    anyExposure = true;
    out.write(
      `  ${red('EXPOSED')} to ${bold(version.key)} at depth ${hit.depth}\n` +
        `          ${dim(hit.chainText)}\n`,
    );
  }

  if (!anyExposure) {
    out.write(
      `  ${green('clean')} — no compromised version is pinned by this lockfile\n` +
        dim(`  (${compromised.length} compromised version(s) checked)\n`),
    );
  } else {
    out.write(
      dim(`\nNext: blastradius time-machine <version>  — were you exposed while it was live?\n`),
    );
  }
}

/** Print what a lockfile contains without writing anything to the graph. */
export async function inspectLockfileCommand(directory: string | undefined): Promise<void> {
  const { parseLockfileAt } = await import('@blast/core');
  const target = resolve(directory ?? process.cwd());
  const out = process.stdout;

  let parsed;
  try {
    parsed = parseLockfileAt(target);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  out.write(`${bold(`LOCKFILE — ${parsed.file}`)}\n`);
  out.write(`  ${pad('format', 20)} ${parsed.kind}\n`);
  out.write(`  ${pad('project', 20)} ${parsed.projectName}\n`);
  out.write(`  ${pad('captured at', 20)} ${iso(parsed.capturedAt)}\n`);
  out.write(`  ${pad('packages', 20)} ${parsed.entries.length}\n`);
  out.write(`  ${pad('direct dependencies', 20)} ${parsed.directDependencies.length}\n`);
  out.write(`  ${pad('resolution edges', 20)} ${parsed.resolutions.length}\n\n`);

  const duplicates = new Map<string, Set<string>>();
  for (const entry of parsed.entries) {
    const versions = duplicates.get(entry.name) ?? new Set<string>();
    versions.add(entry.version);
    duplicates.set(entry.name, versions);
  }
  const multiple = [...duplicates.entries()].filter(([, versions]) => versions.size > 1);

  if (multiple.length > 0) {
    out.write(
      `${bold('Packages installed at more than one version')} ` +
        dim('(npm nesting — each copy is a separate node)\n'),
    );
    for (const [name, versions] of multiple.slice(0, 15)) {
      out.write(`  ${pad(name, 34)} ${yellow([...versions].join(', '))}\n`);
    }
    if (multiple.length > 15) out.write(dim(`  … and ${multiple.length - 15} more\n`));
  }
}
