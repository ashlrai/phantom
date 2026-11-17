import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  classifyPaths, plan, changedPaths, selectRelated, selectFallback, TIER1_TESTS, MAX_RELATED_TESTS, FALLBACK_SHARDS,
} from '../scripts/ci-fast-select.mjs';
import { failedTestFiles, shardWorkers } from '../scripts/ci-fast-run.mjs';
import { prNumber, related, attribute } from '../scripts/ci-fast-attribute.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function repo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-fast-select-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'ci@example.invalid');
  sh(dir, 'config', 'user.name', 'ci');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  const write = (map) => {
    for (const [path, text] of Object.entries(map)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  write(files);
  const commit = (message, map = {}) => { write(map); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', message); return sh(dir, 'rev-parse', 'HEAD'); };
  return { dir, commit, write };
}

test('docs-only diffs select zero tests', () => {
  assert.equal(classifyPaths(['docs/guide.md', 'README.md']).mode, 'docs');
  assert.equal(classifyPaths([]).mode, 'docs');
  assert.equal(classifyPaths(['docs/guide.md', 'src/a.ts']).mode, 'related');
  const r = plan({ cwd: process.cwd(), paths: ['docs/guide.md'] });
  assert.deepEqual([r.mode, r.tests, r.node, r.shards], ['docs', [], [], []]);
});

test('global inputs fall back to a bounded broader set instead of skipping', () => {
  for (const path of ['package-lock.json', 'package.json', 'tsconfig.json', 'src/web-ui/tsconfig.json', 'vitest.config.ts', 'test/setup/home.ts']) {
    assert.equal(classifyPaths(['src/a.ts', path]).mode, 'fallback', path);
  }
  const r = plan({ cwd: process.cwd(), paths: ['package-lock.json'] });
  assert.equal(r.mode, 'fallback');
  assert.equal(r.shards.length, FALLBACK_SHARDS);
  assert.ok(r.tests.length > 0 && r.tests.length <= FALLBACK_SHARDS * 40);
  assert.deepEqual([...r.shards.flat()].sort(), r.tests);
  for (const t of TIER1_TESTS) assert.ok(r.tests.includes(t), `fallback keeps ${t}`);
  assert.deepEqual(selectFallback({ cwd: process.cwd() }).tests, selectFallback({ cwd: process.cwd() }).tests);
});

test('related selection finds changed, name-matched and importing tests', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/alpha.ts': 'export const a = 1;\n',
    'src/core/beta.ts': 'export const b = 2;\n',
    'test/alpha.test.ts': "import '../src/core/alpha.js';\n",
    'test/uses-beta.test.ts': "import { b } from '../src/core/beta.js';\n",
    'test/unrelated.test.ts': "import 'node:fs';\n",
  });
  commit('seed');
  const r = plan({ cwd: dir, paths: ['src/core/beta.ts', 'test/unrelated.test.ts'] });
  assert.equal(r.mode, 'related');
  assert.deepEqual(r.tests, ['test/unrelated.test.ts', 'test/uses-beta.test.ts']);
  const named = plan({ cwd: dir, paths: ['src/core/alpha.ts'] });
  assert.deepEqual(named.tests, ['test/alpha.test.ts']);
});

test('dist-bound tests are deferred, not run without a build', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/gamma.ts': 'export {};\n',
    'test/gamma.test.ts': "import '../src/core/gamma.js';\n",
    'test/gamma-dist.test.ts': "import './helpers/require-built-dist.js';\nimport '../src/core/gamma.js';\n",
  });
  commit('seed');
  const r = plan({ cwd: dir, paths: ['src/core/gamma.ts'] });
  assert.deepEqual(r.tests, ['test/gamma.test.ts']);
  assert.deepEqual(r.deferred, ['test/gamma-dist.test.ts']);
  assert.ok(!selectFallback({ cwd: dir }).tests.includes('test/gamma-dist.test.ts'));
});

test('a code change that maps to no test never skips: it falls back', (t) => {
  const { dir, commit } = repo(t, { 'src/core/lonely.ts': 'export {};\n', 'test/one.test.ts': 'export {};\n' });
  commit('seed');
  const r = plan({ cwd: dir, paths: ['src/core/lonely.ts'] });
  assert.equal(r.mode, 'fallback');
  assert.deepEqual(r.tests, ['test/one.test.ts']);
});

test('Tier-1 paths always add the named authority tests, even past the cap', (t) => {
  const files = { 'src/core/authority/protected-paths.ts': 'export {};\n' };
  for (const name of TIER1_TESTS) files[name] = "import '../src/core/authority/protected-paths.js';\n";
  for (let i = 0; i < MAX_RELATED_TESTS + 10; i += 1) files[`test/a-${String(i).padStart(3, '0')}.test.ts`] = "import '../src/core/authority/protected-paths.js';\n";
  const { dir, commit } = repo(t, files);
  commit('seed');
  const r = plan({ cwd: dir, paths: ['src/core/authority/protected-paths.ts'] });
  assert.equal(r.mode, 'related');
  for (const name of TIER1_TESTS) assert.ok(r.tests.includes(name), name);
  assert.equal(r.tests.length, MAX_RELATED_TESTS);
  assert.ok(r.capped > 0);
  const codeowners = plan({ cwd: dir, paths: ['.github/CODEOWNERS'] });
  for (const name of TIER1_TESTS) assert.ok(codeowners.tests.includes(name), `CODEOWNERS adds ${name}`);
});

test('workflow and script edits select their node and m30 tests', (t) => {
  const { dir, commit } = repo(t, {
    'test/m30.ci.test.ts': 'export {};\n',
    '.github/tests/ci-x.test.mjs': 'export {};\n',
    '.github/scripts/ci-x.mjs': 'export {};\n',
  });
  commit('seed');
  const r = plan({ cwd: dir, paths: ['.github/workflows/ci.yml', '.github/scripts/ci-x.mjs'] });
  assert.deepEqual(r.tests, ['test/m30.ci.test.ts']);
  assert.deepEqual(r.node, ['.github/tests/ci-x.test.mjs']);
});

test('changedPaths uses the merge-base diff and rejects a mismatched checkout', (t) => {
  const { dir, commit, write } = repo(t, { 'a.txt': '1\n' });
  const base = commit('base');
  write({ 'b.txt': '2\n' });
  const head = commit('feature (#7)');
  assert.deepEqual(changedPaths({ base, head, cwd: dir }), ['b.txt']);
  assert.throws(() => changedPaths({ base, head: base, cwd: dir }), /checkout does not match head/);
  assert.throws(() => changedPaths({ base: 'main', head, cwd: dir }), /exact commit SHAs/);
});

test('fallback shards share the runner instead of each taking every CPU', () => {
  assert.equal(shardWorkers(4, 3), 1);
  assert.equal(shardWorkers(16, 3), 5);
  assert.equal(shardWorkers(2, 3), 1);
  assert.equal(shardWorkers(8, 0), 8);
});

test('failed test files parse from vitest and node output', () => {
  const log = ' FAIL  |unit| test/a.test.ts > suite > case\nAssertionError\n × test/b.test.ts 12ms\n✗ .github/tests/c.test.mjs\n FAIL  |real-io| test/a.test.ts > other\n';
  assert.deepEqual(failedTestFiles(log), ['.github/tests/c.test.mjs', 'test/a.test.ts', 'test/b.test.ts']);
  assert.deepEqual(failedTestFiles('all passed'), []);
});

test('an explicit cap can keep more than the fast-gate maximum', (t) => {
  const files = { 'src/core/wide.ts': 'export const w = 1;\n' };
  for (let i = 0; i < 30; i += 1) files[`test/wide-${i}.test.ts`] = "import '../src/core/wide.js';\n";
  const { dir, commit } = repo(t, files);
  commit('seed');
  const capped = selectRelated({ cwd: dir, paths: ['src/core/wide.ts'] });
  const wide = selectRelated({ cwd: dir, paths: ['src/core/wide.ts'], cap: 100 });
  assert.equal(capped.tests.length, MAX_RELATED_TESTS);
  assert.equal(wide.tests.length, 30);
  assert.ok(capped.capped > 0);
  assert.equal(wide.capped, 0);
});

function fastGateSparsePatterns() {
  const yml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../workflows/ci.yml'), 'utf8');
  const start = yml.indexOf('\n  fast-gate:\n');
  assert.ok(start > 0, 'fast-gate job');
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  const job = next < 0 ? rest : rest.slice(0, next + 1);
  const marker = 'sparse-checkout: |';
  const at = job.indexOf(marker);
  assert.ok(at > 0, 'fast-gate sparse-checkout');
  const patterns = [];
  for (const line of job.slice(at + marker.length).split('\n').slice(1)) {
    if (line.trim() === '') continue;
    if (line.search(/\S/) < 12) break;
    patterns.push(line.trim());
  }
  return patterns;
}

function coveredBySparse(file, patterns) {
  return patterns.some((pattern) => file === pattern || file.startsWith(`${pattern}/`));
}

function relativeSpecifiers(text) {
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
}

test('a warm sparse checkout covers every import of ci-fast-select', () => {
  // Runs while fast-gate is still sparse. A restored graph does not expand it.
  // The select step runs while the fast-gate sparse checkout is still on.
  // A restored dependency graph does not expand it, so every relative import
  // has to be inside that list or the step cannot load the module.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const patterns = fastGateSparsePatterns();
  const missing = [];
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!coveredBySparse(file, patterns)) missing.push(file);
    const text = readFileSync(join(repoRoot, file), 'utf8');
    for (const spec of relativeSpecifiers(text)) {
      const next = normalize(join(dirname(file), spec)).replaceAll('\\', '/');
      walk(next);
    }
  };
  walk('.github/scripts/ci-fast-select.mjs');
  assert.deepEqual(missing, []);
  assert.ok(patterns.includes('test/config'));
});

test('merge group attribution maps a failing test to the PR whose commit touched its source', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/one.ts': 'export {};\n', 'src/core/two.ts': 'export {};\n',
    'test/one.test.ts': "import '../src/core/one.js';\n", 'test/two.test.ts': "import '../src/core/two.js';\n",
  });
  const base = commit('base (#1)');
  commit('touch one (#11)', { 'src/core/one.ts': 'export const x = 1;\n' });
  const head = commit('touch two (#12)', { 'src/core/two.ts': 'export const y = 1;\n' });
  const report = attribute({ cwd: dir, base, head, failed: ['test/two.test.ts', 'test/missing.test.ts'] });
  assert.deepEqual(report.batchPrs.sort(), [11, 12]);
  assert.deepEqual(report.failures.find((f) => f.file === 'test/two.test.ts').prs, [12]);
  assert.deepEqual(report.failures.find((f) => f.file === 'test/missing.test.ts').prs, []);
  assert.equal(prNumber('fix thing (#42)'), 42);
  assert.equal(prNumber('no number'), null);
  assert.equal(related('test/x.test.ts', "import '../src/core/y.js'", ['src/core/y.ts']), true);
  assert.equal(related('test/x.test.ts', "import '../src/core/y.js'", ['src/core/z.ts']), false);
});
