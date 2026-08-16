/**
 * Seed packages for ingestion.
 *
 * These are real, widely-depended-on npm packages. The registry has no stable
 * public "most depended upon" endpoint (the old `browse/depended` API is gone
 * and libraries.io needs a key), so the ranking is curated here and checked in,
 * which also makes ingestion deterministic: the same seed list produces the
 * same graph on every clone.
 *
 * The full dependency tree is expanded from these seeds by walking real
 * registry metadata, so the graph itself is not curated — only where it starts.
 */
export const NPM_SEED_PACKAGES: readonly string[] = [
  // --- core utility layer, the packages nearly everything reaches eventually
  'lodash', 'chalk', 'debug', 'semver', 'commander', 'glob', 'minimatch', 'ms',
  'rimraf', 'mkdirp', 'async', 'uuid', 'moment', 'axios', 'request', 'qs',
  'inherits', 'safe-buffer', 'readable-stream', 'string_decoder', 'util-deprecate',
  'isarray', 'core-util-is', 'process-nextick-args', 'wrappy', 'once', 'inflight',
  'concat-map', 'brace-expansion', 'balanced-match', 'path-is-absolute', 'fs.realpath',
  'graceful-fs', 'ansi-styles', 'supports-color', 'color-convert', 'color-name',
  'has-flag', 'escape-string-regexp', 'strip-ansi', 'ansi-regex', 'string-width',
  'is-fullwidth-code-point', 'emoji-regex', 'wrap-ansi', 'cliui', 'yargs', 'yargs-parser',
  'left-pad', 'pad-left', 'repeat-string', 'kind-of', 'is-number', 'is-extendable',
  'extend-shallow', 'is-plain-object', 'isobject', 'define-property', 'is-descriptor',
  'is-accessor-descriptor', 'is-data-descriptor', 'is-buffer', 'to-regex', 'regex-not',

  // --- babel
  '@babel/core', '@babel/parser', '@babel/types', '@babel/traverse', '@babel/generator',
  '@babel/template', '@babel/helper-module-imports', '@babel/runtime', '@babel/preset-env',
  '@babel/code-frame', '@babel/highlight', '@babel/helper-validator-identifier',
  '@babel/compat-data', '@babel/helper-compilation-targets', '@babel/plugin-transform-runtime',

  // --- react and friends
  'react', 'react-dom', 'react-is', 'scheduler', 'prop-types', 'object-assign',
  'react-router', 'react-router-dom', 'redux', 'react-redux', 'styled-components',
  'next', 'preact', 'vue', 'svelte',

  // --- build tooling
  'webpack', 'webpack-cli', 'rollup', 'vite', 'esbuild', 'terser', 'postcss',
  'autoprefixer', 'babel-loader', 'css-loader', 'style-loader', 'source-map',
  'source-map-support', 'acorn', 'acorn-walk', 'estraverse', 'esutils', 'espree',
  'browserslist', 'caniuse-lite', 'electron-to-chromium', 'node-releases',
  'schema-utils', 'loader-utils', 'tapable', 'watchpack', 'enhanced-resolve',

  // --- typescript ecosystem
  'typescript', 'ts-node', 'tslib', '@types/node', '@types/react', '@types/lodash',
  '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', 'ts-loader',

  // --- linting and formatting
  'eslint', 'prettier', 'eslint-plugin-import', 'eslint-config-prettier',
  'eslint-plugin-react', 'eslint-scope', 'eslint-visitor-keys', 'levn', 'optionator',
  'prelude-ls', 'type-check', 'ajv', 'json-schema-traverse', 'fast-deep-equal',
  'fast-json-stable-stringify', 'uri-js', 'punycode',

  // --- testing
  'jest', 'mocha', 'chai', 'sinon', 'vitest', 'tape', 'ava', 'nyc', 'istanbul-lib-coverage',
  'jest-worker', 'expect', 'jsdom', 'supertest', '@jest/core', 'babel-jest',

  // --- servers and http
  'express', 'body-parser', 'cookie', 'cookie-parser', 'cors', 'helmet', 'morgan',
  'koa', 'fastify', 'hapi', 'send', 'serve-static', 'finalhandler', 'accepts',
  'content-type', 'content-disposition', 'depd', 'destroy', 'ee-first', 'encodeurl',
  'escape-html', 'etag', 'fresh', 'http-errors', 'mime', 'mime-types', 'mime-db',
  'negotiator', 'on-finished', 'parseurl', 'path-to-regexp', 'proxy-addr', 'range-parser',
  'setprototypeof', 'statuses', 'toidentifier', 'type-is', 'unpipe', 'utils-merge', 'vary',
  'raw-body', 'bytes', 'iconv-lite', 'safer-buffer', 'media-typer', 'forwarded', 'ipaddr.js',
  'follow-redirects', 'form-data', 'combined-stream', 'delayed-stream', 'asynckit',
  'node-fetch', 'whatwg-url', 'tr46', 'webidl-conversions', 'ws', 'socket.io',

  // --- filesystem, paths, globbing
  'fs-extra', 'jsonfile', 'universalify', 'chokidar', 'anymatch', 'braces', 'fill-range',
  'to-regex-range', 'micromatch', 'picomatch', 'readdirp', 'normalize-path', 'binary-extensions',
  'is-binary-path', 'is-glob', 'is-extglob', 'glob-parent', 'globby', 'fast-glob',
  'dir-glob', 'path-type', 'slash', 'ignore', 'merge2', '@nodelib/fs.stat',
  '@nodelib/fs.walk', '@nodelib/fs.scandir', 'run-parallel', 'queue-microtask',

  // --- data, crypto, encoding
  'bluebird', 'rxjs', 'immer', 'immutable', 'ramda', 'date-fns', 'dayjs', 'luxon',
  'js-yaml', 'argparse', 'sprintf-js', 'esprima', 'ini', 'dotenv', 'minimist',
  'nanoid', 'bignumber.js', 'decimal.js', 'crypto-js', 'bcrypt', 'jsonwebtoken',
  'jws', 'jwa', 'ecdsa-sig-formatter', 'buffer-equal-constant-time', 'base64-js',
  'ieee754', 'buffer', 'md5', 'sha.js', 'hash-base', 'cipher-base', 'create-hash',

  // --- cli and terminal
  'inquirer', 'ora', 'cli-cursor', 'restore-cursor', 'signal-exit', 'onetime',
  'mimic-fn', 'figures', 'log-symbols', 'cli-spinners', 'is-interactive', 'is-unicode-supported',
  'boxen', 'update-notifier', 'yeoman-generator', 'listr', 'enquirer', 'prompts',
  'kleur', 'picocolors', 'colorette', 'nanocolors', 'term-size', 'ansi-escapes',

  // --- databases and clients
  'mongoose', 'mongodb', 'pg', 'mysql2', 'redis', 'ioredis', 'sequelize', 'knex',
  'prisma', 'typeorm', 'sqlite3', 'better-sqlite3', 'bson', 'denque',

  // --- misc widely-used
  'classnames', 'clsx', 'tiny-invariant', 'invariant', 'warning', 'hoist-non-react-statics',
  'regenerator-runtime', 'core-js', 'whatwg-fetch', 'promise', 'setimmediate',
  'nan', 'node-gyp', 'node-addon-api', 'bindings', 'file-uri-to-path',
  'tar', 'zip-stream', 'archiver', 'yauzl', 'yazl', 'pump', 'end-of-stream',
  'through2', 'split2', 'duplexify', 'stream-shift', 'pumpify', 'peek-stream',
  'cross-spawn', 'execa', 'which', 'isexe', 'shebang-command', 'shebang-regex',
  'npm-run-path', 'path-key', 'get-stream', 'human-signals', 'strip-final-newline',
  'resolve', 'resolve-from', 'is-core-module', 'path-parse', 'find-up', 'locate-path',
  'p-locate', 'p-limit', 'p-try', 'pkg-dir', 'read-pkg', 'read-pkg-up', 'normalize-package-data',
  'hosted-git-info', 'validate-npm-package-license', 'spdx-correct', 'spdx-expression-parse',
  'spdx-license-ids', 'spdx-exceptions', 'lru-cache', 'yallist', 'json5', 'strip-bom',
  'strip-json-comments', 'parse-json', 'error-ex', 'is-arrayish', 'lines-and-columns',
  'callsites', 'deepmerge', 'clone', 'clone-deep', 'shallow-clone', 'defaults',
];

/** PyPI seeds, used when INGEST_ECOSYSTEMS includes `pypi`. */
export const PYPI_SEED_PACKAGES: readonly string[] = [
  'requests', 'urllib3', 'certifi', 'charset-normalizer', 'idna', 'setuptools', 'six',
  'python-dateutil', 'numpy', 'pandas', 'pyyaml', 'boto3', 'botocore', 'jmespath',
  's3transfer', 'click', 'flask', 'jinja2', 'markupsafe', 'werkzeug', 'itsdangerous',
  'django', 'sqlalchemy', 'pytest', 'pluggy', 'packaging', 'attrs', 'pyparsing',
  'typing-extensions', 'pydantic', 'fastapi', 'starlette', 'uvicorn', 'httpx', 'httpcore',
  'anyio', 'sniffio', 'h11', 'colorama', 'tqdm', 'rich', 'pygments', 'markdown-it-py',
  'protobuf', 'grpcio', 'cryptography', 'cffi', 'pycparser', 'pillow', 'scipy',
  'scikit-learn', 'joblib', 'threadpoolctl', 'matplotlib', 'cycler', 'kiwisolver',
  'fonttools', 'pytz', 'tzdata', 'greenlet', 'psycopg2-binary', 'redis', 'celery',
];

export function seedsFor(ecosystem: string, count: number): string[] {
  const list = ecosystem === 'pypi' ? PYPI_SEED_PACKAGES : NPM_SEED_PACKAGES;
  return [...list].slice(0, Math.max(0, count));
}
