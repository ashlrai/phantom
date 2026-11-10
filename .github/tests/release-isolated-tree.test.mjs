/* global process */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createIsolatedTree, ignoredEntries, sourceDrift, verifyIsolatedTree } from '../../scripts/release-isolated-tree.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/release-isolated-tree.mjs', import.meta.url));

// Hermetic git: no system/global config, templates or hooks from the host.
function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-isolated-tree-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const home = join(parent, 'home'); mkdirSync(home);
  const template = join(parent, 'template'); mkdirSync(template);
  const env = { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'no-global'),
    GIT_TEMPLATE_DIR: template, GIT_CONFIG_COUNT: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const source = join(parent, 'source'); mkdirSync(source);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(source, 'init', '--quiet');
  writeFileSync(join(source, '.gitignore'), 'dist/\nnode_modules/\ndesktop/src-tauri/target/\n*.log\n');
  writeFileSync(join(source, 'package.json'), '{"name":"@ashlr/phantom","version":"1.0.0"}\n');
  mkdirSync(join(source, 'src')); writeFileSync(join(source, 'src/index.ts'), 'export {};\n');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Tree fixture', '-c', 'user.email=tree@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'pin');
  const sha = git(source, 'rev-parse', 'HEAD');
  return { parent, source, sha, git };
}

function created(t) {
  const f = fixture(t);
  const root = createIsolatedTree({ source: f.source, sha: f.sha, path: join(f.parent, 'tree') });
  return { ...f, root };
}

const refuses = (f, pattern) => assert.throws(() => verifyIsolatedTree({ root: f.root, sha: f.sha }), pattern);

test('creates a detached pinned tree that excludes every byte of a dirty job checkout', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'src/index.ts'), 'export const leaked = true;\n');
  writeFileSync(join(f.source, 'stray.txt'), 'untracked');
  mkdirSync(join(f.source, 'dist')); writeFileSync(join(f.source, 'dist/stale.js'), 'stale build');
  const root = createIsolatedTree({ source: f.source, sha: f.sha, path: join(f.parent, 'tree') });
  assert.notEqual(root, f.source);
  assert.equal(f.git(root, 'rev-parse', 'HEAD'), f.sha);
  assert.equal(f.git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'tree must be detached');
  assert.equal(readFileSync(join(root, 'src/index.ts'), 'utf8'), 'export {};\n');
  assert.equal(existsSync(join(root, 'stray.txt')), false);
  assert.equal(existsSync(join(root, 'dist')), false);
  assert.deepEqual(sourceDrift(root, f.sha), []);
  assert.deepEqual(ignoredEntries(root), []);
  assert.equal(verifyIsolatedTree({ root, sha: f.sha }), root);
});

test('accepts an empty mktemp directory and refuses unsafe destinations or commits', (t) => {
  const f = fixture(t);
  const empty = mkdtempSync(join(f.parent, 'mktemp-'));
  assert.equal(createIsolatedTree({ source: f.source, sha: f.sha, path: empty }), realpathSync(empty));
  const occupied = mkdtempSync(join(f.parent, 'occupied-')); writeFileSync(join(occupied, 'x'), 'x');
  assert.throws(() => createIsolatedTree({ source: f.source, sha: f.sha, path: occupied }), /not an empty directory/);
  assert.throws(() => createIsolatedTree({ source: f.source, sha: f.sha, path: 'relative/tree' }), /absolute/);
  assert.throws(() => createIsolatedTree({ source: f.source, sha: f.sha, path: join(f.parent, 'missing', 'tree') }));
  assert.throws(() => createIsolatedTree({ source: f.source, sha: 'a'.repeat(40), path: join(f.parent, 'unknown') }));
  assert.throws(() => createIsolatedTree({ source: f.source, sha: 'HEAD', path: join(f.parent, 'symbolic') }), /exact pinned commit/);
});

test('admits declared, gitignored build outputs after a build', (t) => {
  const f = created(t);
  for (const path of ['dist/cli/index.js', 'node_modules/.cache/phantom-backend.tsbuildinfo', 'desktop/src-tauri/target/debug/app']) {
    mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), 'built');
  }
  assert.deepEqual(ignoredEntries(f.root), ['desktop/src-tauri/target/debug/app', 'dist/cli/index.js', 'node_modules/.cache/phantom-backend.tsbuildinfo']);
  assert.equal(verifyIsolatedTree({ root: f.root, sha: f.sha }), f.root);
});

test('refuses an injected tracked-file edit with git diff against the pinned commit', (t) => {
  const f = created(t);
  writeFileSync(join(f.root, 'src/index.ts'), 'export const injected = true;\n');
  refuses(f, /source changed after build:\nM src\/index\.ts$/m);
});

for (const [name, mutate, pattern] of [
  ['tracked deletion', (f) => rmSync(join(f.root, 'package.json')), /^D package\.json$/m],
  ['mode change', (f) => chmodSync(join(f.root, 'src/index.ts'), 0o755), /^M src\/index\.ts$/m],
  ['staged new file', (f) => { writeFileSync(join(f.root, 'src/new.ts'), 'x'); f.git(f.root, 'add', 'src/new.ts'); }, /^A src\/new\.ts \(index\)$/m],
  ['staged edit restored in the worktree', (f) => {
    writeFileSync(join(f.root, 'src/index.ts'), 'staged'); f.git(f.root, 'add', 'src/index.ts');
    writeFileSync(join(f.root, 'src/index.ts'), 'export {};\n');
  }, /^M src\/index\.ts \(index\)$/m],
  ['untracked unignored file', (f) => writeFileSync(join(f.root, 'generated.json'), '{}'), /^\?\? generated\.json$/m],
  ['skip-worktree hidden edit', (f) => {
    f.git(f.root, 'update-index', '--skip-worktree', 'src/index.ts'); writeFileSync(join(f.root, 'src/index.ts'), 'hidden');
  }, /^S src\/index\.ts \(hidden index flag\)$/m],
  ['assume-unchanged hidden edit', (f) => {
    f.git(f.root, 'update-index', '--assume-unchanged', 'src/index.ts'); writeFileSync(join(f.root, 'src/index.ts'), 'hidden');
  }, /^h src\/index\.ts \(hidden index flag\)$/m],
  ['new .gitignore hiding a write', (f) => {
    mkdirSync(join(f.root, 'docs')); writeFileSync(join(f.root, 'docs/.gitignore'), '*\n'); writeFileSync(join(f.root, 'docs/llms.txt'), 'x');
  }, /^!! docs\/\.gitignore \(undeclared build output\)\n!! docs\/llms\.txt \(undeclared build output\)$/m],
  ['info/exclude hiding a write', (f) => {
    const exclude = f.git(f.root, 'rev-parse', '--git-path', 'info/exclude');
    const path = exclude.startsWith('/') ? exclude : join(f.root, exclude);
    mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'hidden.json\n'); writeFileSync(join(f.root, 'hidden.json'), '{}');
  }, /^!! hidden\.json \(undeclared build output\)$/m],
  ['ignored but undeclared output', (f) => writeFileSync(join(f.root, 'build.log'), 'log'), /^!! build\.log \(undeclared build output\)$/m],
  ['moved HEAD', (f) => {
    f.git(f.root, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'moved');
  }, /^HEAD [a-f0-9]{40} is not pinned/m],
]) {
  test(`refuses ${name}`, (t) => {
    const f = created(t);
    mutate(f);
    refuses(f, pattern);
  });
}

test('CLI creates from GITHUB_SHA, records the root output and fails verify on drift', (t) => {
  const f = fixture(t);
  const output = join(f.parent, 'github-output'); writeFileSync(output, '');
  const env = { ...process.env, GITHUB_SHA: f.sha, ASHLR_RELEASE_SHA: '', GITHUB_OUTPUT: output };
  const path = join(f.parent, 'cli-tree');
  const root = execFileSync(process.execPath, [SCRIPT, 'create', path], { cwd: f.source, env, encoding: 'utf8' }).trim();
  assert.equal(root, realpathSync(path));
  assert.equal(readFileSync(output, 'utf8'), `root=${root}\n`);
  const clean = spawnSync(process.execPath, [SCRIPT, 'verify', root], { cwd: root, env, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  writeFileSync(join(root, 'package.json'), '{}\n');
  const dirty = spawnSync(process.execPath, [SCRIPT, 'verify', root], { cwd: root, env, encoding: 'utf8' });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /isolated release tree refused: source changed after build:\nM package\.json/);
  const unpinned = spawnSync(process.execPath, [SCRIPT, 'verify', root], { cwd: root, env: { ...env, GITHUB_SHA: '' }, encoding: 'utf8' });
  assert.equal(unpinned.status, 1);
  assert.match(unpinned.stderr, /missing exact pinned release commit/);
});
