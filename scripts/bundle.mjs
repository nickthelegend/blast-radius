#!/usr/bin/env node
/**
 * Bundle the CLI into one file for publishing.
 *
 * The repository is an npm workspace: `@blast/cli` imports `@blast/core`, and
 * both are private packages that will never exist on the registry. A published
 * tarball that keeps those imports resolves nothing and dies on first run —
 * which is exactly what `npm pack` + install proved before this existed.
 *
 * So the published artifact is a single bundled file with the workspace
 * boundary erased. Node built-ins stay external, and so does `neo4j-driver`:
 * it is an optional transport, and bundling it would force every install to
 * carry a driver most runs never touch.
 */
import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

const outfile = 'dist/blastradius.mjs';

await build({
  entryPoints: ['packages/cli/dist/index.js'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Left external on purpose: an optional Bolt transport, and the one
  // dependency with native bindings.
  external: ['neo4j-driver'],
  banner: {
    // No shebang here: esbuild hoists the entry file's own to the top, and a
    // second one lands on line 2 where it is a syntax error rather than a
    // comment. Only the CommonJS shim is added — esbuild's ESM output has
    // none, and express reaches for `require` through its dependency graph.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

await chmod(outfile, 0o755);
console.log(`bundled -> ${outfile}`);
