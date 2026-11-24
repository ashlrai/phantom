#!/usr/bin/env node
/**
 * Local pre-push gate. Runs the same affected set as the hosted fast jobs:
 * secret-shape on the diff, affected typecheck, affected lint, and the fast
 * gate's selected tests. A prior green result for the same input hash is
 * reused. A miss runs the check.
 *
 *   scripts/prepush-gate
 *   node scripts/prepush-gate.mjs [--base origin/master]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proveReuse, receiptFor } from '../.github/scripts/ci-green-reuse.mjs';
import { plan } from '../.github/scripts/ci-fast-select.mjs';
import { affectedProjects, lintFiles } from '../.github/scripts/ci-dep-graph.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function cacheDir() {
  const common = git(['rev-parse', '--git-common-dir']);
  if (common.status !== 0) fail('not a git checkout');
  const dir = resolve(root, common.stdout.trim(), 'phantom-prepush');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function reuse(dir, job, hash) {
  const path = resolve(dir, `${job}.json`);
  try {
    return proveReuse(readFileSync(path, 'utf8'), job, hash);
  } catch {
    return false;
  }
}

function remember(dir, job, hash) {
  writeFileSync(resolve(dir, `${job}.json`), receiptFor(job, hash));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const baseArg = process.argv.indexOf('--base');
const baseRef = baseArg === -1 ? 'origin/master' : process.argv[baseArg + 1];
if (!baseRef || baseRef.startsWith('--')) fail('usage: scripts/prepush-gate [--base origin/master]');

const mergeBase = git(['merge-base', 'HEAD', baseRef]);
if (mergeBase.status !== 0) fail(`cannot resolve merge-base with ${baseRef}`);
const diff = git(['diff', '--name-only', '--no-renames', '-z', mergeBase.stdout.trim(), 'HEAD']);
if (diff.status !== 0) fail('cannot list changed paths');
const paths = diff.stdout.split('\0').filter(Boolean);
const patch = git(['diff', '--no-color', '--no-ext-diff', mergeBase.stdout.trim(), 'HEAD']);
if (patch.status !== 0) fail('cannot read the candidate diff');

const shape = spawnSync('perl', [resolve(root, '.github/tests/secret-shape/scrub.pl'), '--check', '--allow-fixtures'], {
  input: patch.stdout, encoding: 'utf8',
});
if (shape.status !== 0) fail(`secret-shape scan failed\n${shape.stdout ?? ''}`);

const dir = cacheDir();
const patchHash = createHash('sha256').update(patch.stdout).digest('hex');
const started = Date.now();
if (!reuse(dir, 'prepush-shape', patchHash)) remember(dir, 'prepush-shape', patchHash);

const graphPath = resolve(dir, 'dep-graph.json');
run(process.execPath, [resolve(root, '.github/scripts/ci-dep-graph.mjs'), 'update', '--out', graphPath]);
const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
const selection = plan({ cwd: root, paths, graph });
const workHash = createHash('sha256').update(JSON.stringify({ paths, mode: selection.mode, tests: selection.tests })).digest('hex');
if (reuse(dir, 'prepush-work', workHash)) {
  console.log(`prepush gate reused a prior green result in ${Date.now() - started}ms`);
  process.exit(0);
}

const projects = affectedProjects(paths, graph);
if (projects !== 'none' || selection.mode !== 'docs') {
  if (projects !== 'none' && !existsSync(resolve(root, 'node_modules/@typescript/native-preview'))) {
    fail('dependencies are not installed; run npm ci before the pre-push gate');
  }
  if (projects === 'web') run('npx', ['--no-install', 'tsgo', '--noEmit', '-p', 'src/web-ui/tsconfig.json']);
  else if (projects === 'backend') run('npx', ['--no-install', 'tsgo', '--noEmit']);
  else if (projects === 'both') run('npm', ['run', 'typecheck']);
  const lintable = lintFiles(paths, graph);
  if (lintable.length) {
    if (!existsSync(resolve(root, 'node_modules/eslint/bin/eslint.js'))) fail('eslint is not installed');
    run(process.execPath, ['node_modules/eslint/bin/eslint.js', ...lintable]);
  }
  if (selection.tests.length) run(process.execPath, ['scripts/test-ci.mjs', ...selection.tests]);
  if (selection.node.length) run(process.execPath, ['--test', ...selection.node]);
}

remember(dir, 'prepush-work', workHash);
console.log(`prepush gate passed (${selection.mode}) in ${Date.now() - started}ms`);
