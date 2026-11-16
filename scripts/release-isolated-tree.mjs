#!/usr/bin/env node
/**
 * release-isolated-tree.mjs — one pinned commit, one fresh detached worktree.
 *
 * Release build, pack and desktop smoke run only inside a tree created here,
 * never in the job (or operator) checkout, so nothing an earlier step left in
 * that checkout can reach release bytes:
 *
 *   node scripts/release-isolated-tree.mjs create "$(mktemp -d)"   # prints the tree root
 *   node scripts/release-isolated-tree.mjs verify <root>           # strict drift check
 *
 * The commit comes from ASHLR_RELEASE_SHA, else GITHUB_SHA (exact 40-hex).
 *
 * The drift check stays strict. Against the pinned commit it refuses:
 *   - HEAD that is not the pinned commit;
 *   - any tracked byte, mode, deletion or addition in the worktree
 *     (`git diff --exit-code <sha>`) or the index (`--cached`);
 *   - any untracked file that is not ignored;
 *   - hidden index flags (assume-unchanged / skip-worktree) that make git
 *     status and diff blind to an edit;
 *   - with `verify`, any ignored output outside the declared build-output
 *     inventory (scripts/build-outputs.mjs), so a new .gitignore, an edited
 *     info/exclude or an undeclared generated directory cannot hide a write.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { undeclaredBuildOutputs } from './build-outputs.mjs';

const SHA = /^[a-f0-9]{40}$/;
// Repository selection comes only from cwd; inherited GIT_* overrides could
// point the check at another index or work tree.
const GIT_OVERRIDES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
// Mode changes always count; hooks never run during worktree creation.
const GIT_HARDENING = ['-c', 'core.fileMode=true', '-c', 'core.quotePath=false', '-c', 'core.hooksPath=/dev/null'];

function gitEnv() {
  const env = { ...process.env };
  for (const key of GIT_OVERRIDES) delete env[key];
  return env;
}

function runGit(cwd, args, { exitCodes = [0] } = {}) {
  const result = spawnSync('git', [...GIT_HARDENING, ...args], {
    cwd, env: gitEnv(), encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  assert.ok(exitCodes.includes(result.status), `git ${args[0]} exited ${result.status}: ${result.stderr.trim()}`);
  return result;
}

const records = (text) => text.split('\0').filter(Boolean);

/** Pairs `-z --name-status` output (status, path) into `"<status> <path>"` lines. */
function nameStatus(text, suffix = '') {
  const parts = records(text); const lines = [];
  for (let i = 0; i + 1 < parts.length; i += 2) lines.push(`${parts[i]} ${parts[i + 1]}${suffix}`);
  return lines;
}

export function requirePinnedSha(env = process.env) {
  const sha = (env.ASHLR_RELEASE_SHA || env.GITHUB_SHA || '').trim();
  assert.match(sha, SHA, 'missing exact pinned release commit (ASHLR_RELEASE_SHA or GITHUB_SHA)');
  return sha;
}

/**
 * Every way the tree at `root` differs from commit `sha`, as porcelain-like
 * lines. Empty means the tracked tree is byte- and mode-identical to the pin
 * and no unignored file exists.
 */
export function sourceDrift(root, sha) {
  assert.match(sha ?? '', SHA, 'missing exact pinned commit');
  const head = runGit(root, ['rev-parse', '--verify', 'HEAD']).stdout.trim();
  const drift = head === sha ? [] : [`HEAD ${head} is not pinned ${sha}`];
  const diff = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-renames', '--exit-code', '--name-status', '-z'];
  // --exit-code: 0 identical, 1 differs (listed below); anything else refuses.
  drift.push(...nameStatus(runGit(root, [...diff, sha, '--'], { exitCodes: [0, 1] }).stdout));
  drift.push(...nameStatus(runGit(root, [...diff, '--cached', sha, '--'], { exitCodes: [0, 1] }).stdout, ' (index)'));
  for (const row of records(runGit(root, ['ls-files', '-v', '-z']).stdout)) {
    if (!row.startsWith('H ')) drift.push(`${row.slice(0, 1)} ${row.slice(2)} (hidden index flag)`);
  }
  for (const path of records(runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout)) drift.push(`?? ${path}`);
  return [...new Set(drift)];
}

/** Every ignored untracked file, one path each (no directory collapsing, which is ambiguous for untracked parents). */
export function ignoredEntries(root) {
  return records(runGit(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).stdout).sort();
}

export function verifyIsolatedTree({ root, sha, declaredOutputs = true }) {
  root = realpathSync(root);
  const drift = sourceDrift(root, sha);
  const undeclared = declaredOutputs ? undeclaredBuildOutputs(ignoredEntries(root)).map((path) => `!! ${path} (undeclared build output)`) : [];
  if (drift.length || undeclared.length) {
    assert.fail(`source changed after build:\n${[...drift, ...undeclared].join('\n')}`);
  }
  return root;
}

/**
 * `git worktree add --detach <path> <sha>` from `source`. `path` must be absent
 * (its parent must exist) or an empty directory such as `mktemp -d` returns.
 * The new tree must be pristine: pinned HEAD, no drift, no ignored files.
 */
export function createIsolatedTree({ source, sha, path }) {
  assert.match(sha ?? '', SHA, 'missing exact pinned commit');
  assert.ok(typeof path === 'string' && isAbsolute(path), 'isolated tree path must be absolute');
  source = realpathSync(source);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(path).length === 0,
      'isolated tree path exists and is not an empty directory');
  } else {
    assert.ok(lstatSync(dirname(path)).isDirectory(), 'isolated tree parent is missing');
  }
  const commit = runGit(source, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]).stdout.trim();
  assert.equal(commit, sha, 'pinned commit is not present in the source repository');
  const resolved = resolve(path);
  runGit(source, ['worktree', 'add', '--detach', '--quiet', resolved, sha]);
  const root = realpathSync(resolved);
  assert.notEqual(root, source, 'isolated tree must not be the source checkout');
  assert.equal(realpathSync(runGit(root, ['rev-parse', '--show-toplevel']).stdout.trim()), root, 'isolated tree is not its own worktree');
  const drift = sourceDrift(root, sha);
  assert.deepEqual(drift, [], `fresh isolated tree is not pristine:\n${drift.join('\n')}`);
  assert.deepEqual(ignoredEntries(root), [], 'fresh isolated tree already contains ignored files');
  return root;
}

function main() {
  try {
    const [verb, operand, extra] = process.argv.slice(2);
    if (verb === '-h' || verb === '--help') {
      console.log('Usage: node scripts/release-isolated-tree.mjs create <empty-or-absent-path> | verify <root>\n'
        + 'Pinned commit: ASHLR_RELEASE_SHA, else GITHUB_SHA.');
      return;
    }
    assert.equal(extra, undefined, 'unexpected operand');
    assert.ok(operand, 'missing path operand');
    const sha = requirePinnedSha();
    if (verb === 'create') {
      const root = createIsolatedTree({ source: process.cwd(), sha, path: resolve(operand) });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `root=${root}\n`);
      console.log(root);
    } else if (verb === 'verify') {
      const root = verifyIsolatedTree({ root: operand, sha });
      console.log(`isolated release tree ${root} matches ${sha}`);
    } else {
      assert.fail('expected create or verify');
    }
  } catch (error) {
    console.error(`isolated release tree refused: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
