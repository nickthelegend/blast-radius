import { join } from 'node:path';

import {
  HydraClient,
  IdRegistry,
  ID_MAP_FILE,
  findVersion,
  loadConfig,
  hydraConfigFrom,
  suggestVersions,
  type BlastConfig,
} from '@blast/core';

export interface Context {
  config: BlastConfig;
  client: HydraClient;
  ids: IdRegistry;
  idMapPath: string;
}

export function createContext(): Context {
  const config = loadConfig();
  const client = new HydraClient(hydraConfigFrom(config));
  const idMapPath = join(config.paths.snapshot, ID_MAP_FILE);
  const ids = IdRegistry.load(idMapPath);
  return { config, client, ids, idMapPath };
}

/** Exit with a clean message instead of a stack trace for expected failures. */
export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Resolve a version key, or exit naming what the user probably meant.
 *
 * The key format is `ecosystem:package@version`, and nothing about typing
 * `debug@4.4.3` announces that the `npm:` prefix is required. Failing with a
 * bare "not found" makes the tool look broken when the graph is fine.
 */
export async function requireVersion(
  client: HydraClient,
  key: string,
): Promise<NonNullable<Awaited<ReturnType<typeof findVersion>>>> {
  const version = await findVersion(client, key);
  if (version) return version;

  const suggestions = await suggestVersions(client, key);
  fail(
    `version not found in the graph: ${key}` +
      (suggestions.length > 0
        ? `\n\nDid you mean:\n${suggestions.map((s) => `  ${s}`).join('\n')}`
        : '\n\nKeys look like `npm:debug@4.4.3`. Try `blastradius stats` for what is loaded.'),
  );
}

/**
 * Parse an ISO-8601 instant. Accepts the forms a user actually types, and
 * rejects anything ambiguous rather than silently guessing a timezone.
 */
export function parseInstant(value: string, label: string): number {
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    fail(
      `${label}: could not parse ${JSON.stringify(value)} as a timestamp.\n` +
        `Use an ISO-8601 instant, e.g. "2026-08-14T09:00:00Z".`,
    );
  }
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed) && trimmed.includes('T')) {
    process.stderr.write(
      `warning: ${label} has no timezone offset; interpreting ${JSON.stringify(value)} as local time.\n`,
    );
  }
  return parsed;
}
