#!/usr/bin/env node
/**
 * Standalone ingestion runner.
 * `make ingest` calls the CLI; this exists so ingestion can also be driven
 * directly (in CI, or while the CLI is being rebuilt) without a build step
 * beyond @blast/core.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, runIngest } from '../packages/core/dist/index.js';

const config = loadConfig();
const startedAt = Date.now();

// Progress goes to a file as well as stdout: when this runs in the background
// its stdout is a pipe, and Node buffers pipes, so the log would otherwise only
// appear once the whole run finished.
const logPath = join(config.paths.data, 'ingest.log');
writeFileSync(logPath, `ingest started ${new Date().toISOString()}\n`);
const log = (message) => {
  const line = `[${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${message}`;
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
};

const snapshot = await runIngest({ config, onLog: log });

console.log('---');
console.log(`packages          ${snapshot.packages.length}`);
console.log(`versions          ${snapshot.versions.length}`);
console.log(`maintainers       ${snapshot.maintainers.length}`);
console.log(`repos             ${snapshot.repos.length}`);
console.log(`lockfiles         ${snapshot.snapshots.length}`);
console.log(`DEPENDS_ON        ${snapshot.depends_on.length}`);
console.log(`RESOLVED_TO       ${snapshot.resolved_to.length}`);
console.log(`RESOLVED          ${snapshot.resolved.length}`);
console.log(`MAINTAINS         ${snapshot.maintains.length}`);
console.log(`NAME_SIMILAR_TO   ${snapshot.name_similar_to.length}`);
console.log(`advisories        ${snapshot.advisories.length}`);
console.log(`elapsed           ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
