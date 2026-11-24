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

test('docs-only diffs still classify as docs but select the suites that read them', (t) => {
  assert.equal(classifyPaths(['docs/guide.md', 'README.md']).mode, 'docs');
  assert.equal(classifyPaths([]).mode, 'docs');
  assert.equal(classifyPaths(['docs/guide.md', 'src/a.ts']).mode, 'related');
  const { dir, commit } = repo(t, {
    'docs/guide.md': '# Guide\n',
    'docs/other.md': '# Other\n',
    'test/docs-repo-links.test.ts': 'export {};\n',
    'test/guide-reader.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('docs/guide.md', 'utf8');\n",
    'test/join-reader.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync(join('docs', 'other.md'), 'utf8');\n",
    'test/unrelated.test.ts': 'export {};\n',
  });
  commit('seed');
  const r = plan({ cwd: dir, paths: ['docs/guide.md'] });
  assert.equal(r.mode, 'related');
  assert.deepEqual(r.tests, ['test/docs-repo-links.test.ts', 'test/guide-reader.test.ts']);
  const joined = plan({ cwd: dir, paths: ['docs/other.md'] });
  assert.equal(joined.mode, 'related');
  assert.deepEqual(joined.tests, ['test/docs-repo-links.test.ts', 'test/join-reader.test.ts']);
  const empty = plan({ cwd: dir, paths: [] });
  assert.deepEqual([empty.mode, empty.tests, empty.node, empty.shards], ['docs', [], [], []]);
});

test('docs selection defers dist-bound readers and caps like related selection', (t) => {
  const files = {
    'docs/guide.md': '# Guide\n',
    'test/docs-repo-links.test.ts': 'export {};\n',
    'test/guide-dist-reader.test.ts': "import './helpers/require-built-dist.js';\nreadFileSync('docs/guide.md', 'utf8');\n",
  };
  for (let i = 0; i < MAX_RELATED_TESTS + 5; i += 1) {
    files[`test/guide-reader-${String(i).padStart(3, '0')}.test.ts`] = "readFileSync('docs/guide.md', 'utf8');\n";
  }
  const { dir, commit } = repo(t, files);
  commit('seed');
  const r = plan({ cwd: dir, paths: ['docs/guide.md'] });
  assert.equal(r.mode, 'related');
  assert.ok(r.tests.includes('test/docs-repo-links.test.ts'));
  assert.ok(!r.tests.includes('test/guide-dist-reader.test.ts'));
  assert.deepEqual(r.deferred, ['test/guide-dist-reader.test.ts']);
  assert.equal(r.tests.length, MAX_RELATED_TESTS);
  assert.ok(r.capped > 0);
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
  const manifest = plan({ cwd: process.cwd(), paths: ['package.json'] });
  assert.ok(manifest.tests.includes('test/package-files-allowlist.test.ts'));
  assert.ok(manifest.shards.some((shard) => shard.includes('test/package-files-allowlist.test.ts')));
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

test('the native gateway declares its build requirement and stays in the full lane', (t) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const gateway = 'test/m31.gateway-native.test.ts';
  const { dir: cwd, commit } = repo(t, {
    [gateway]: readFileSync(join(root, gateway), 'utf8'),
    'test/source-only.test.ts': 'export {};\n',
  });
  commit('native gateway suite');
  const selected = selectRelated({ cwd, paths: [gateway] });
  assert.deepEqual(selected.tests, []);
  assert.deepEqual(selected.deferred, [gateway]);
  assert.ok(!selectFallback({ cwd }).tests.includes(gateway));
  const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  assert.match(config, /include: \['test\/\*\*\/\*\.test\.ts'\]/);
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /run: npm run build[\s\S]*run: npm run test:ci -- \$\{\{ matrix\.test_args \}\}/);
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

test('a diff touching a recorded Tier-1 closure member selects the closure invariant', (t) => {
  const snapshot = 'test/fixtures/authority/tier1-closure.json';
  const { dir, commit } = repo(t, {
    'src/core/fleet/lane-console.ts': 'export const lc = 1;\n',
    'src/core/fleet/unrelated.ts': 'export const u = 1;\n',
    'test/lane-console.test.ts': "import '../src/core/fleet/lane-console.js';\n",
    'test/unrelated.test.ts': "import '../src/core/fleet/unrelated.js';\n",
    [snapshot]: JSON.stringify({ closure: ['src/core/fleet/lane-console.ts'] }),
    'test/authority-tier1-closure-310b.test.ts': 'export {};\n',
  });
  commit('seed');
  const member = plan({ cwd: dir, paths: ['src/core/fleet/lane-console.ts'] });
  assert.ok(member.tests.includes('test/authority-tier1-closure-310b.test.ts'), 'closure member diff runs the invariant');
  const snap = plan({ cwd: dir, paths: [snapshot] });
  assert.ok(snap.tests.includes('test/authority-tier1-closure-310b.test.ts'), 'snapshot regen runs the invariant');
  const other = plan({ cwd: dir, paths: ['src/core/fleet/unrelated.ts'] });
  assert.ok(!other.tests.includes('test/authority-tier1-closure-310b.test.ts'), 'non-member diff does not');
  const newRoot = plan({ cwd: dir, paths: ['src/core/memory/brand-new.ts'] });
  assert.ok(newRoot.tests.includes('test/authority-tier1-closure-310b.test.ts'), 'a new root-eligible file runs the invariant');
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

test('CLI registry edits select the anti-drift suite that reads the dispatch switch as text', (t) => {
  const { dir, commit } = repo(t, {
    'src/cli/index.ts': 'export {};\n',
    'src/cli/completions.ts': 'export const c = 1;\n',
    'src/cli/help.ts': 'export const h = 1;\n',
    'src/cli/outbox.ts': 'export const o = 1;\n',
    'test/cli-registry-drift.test.ts': 'export {};\n',
    'test/unrelated.test.ts': 'export {};\n',
  });
  commit('seed');
  // index.ts has no import edge into the suite — it parses the switch as
  // text — so only the named rule can select it.
  for (const path of ['src/cli/index.ts', 'src/cli/completions.ts', 'src/cli/help.ts']) {
    const r = plan({ cwd: dir, paths: [path] });
    assert.equal(r.mode, 'related');
    assert.ok(r.tests.includes('test/cli-registry-drift.test.ts'), `${path} selects the drift suite`);
  }
  const impl = selectRelated({ cwd: dir, paths: ['src/cli/outbox.ts'] });
  assert.ok(!impl.tests.includes('test/cli-registry-drift.test.ts'), 'a command implementation alone does not');
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

test('failed test files parse colored Vitest project badges without matching passing lines', () => {
  const log = '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m \x1b[30m\x1b[42m unit \x1b[49m\x1b[39m test/authority-tier1-closure-310b.test.ts\x1b[2m > \x1b[22mTier-1 authority import closure (SPEC-310B §2)\n';
  assert.deepEqual(failedTestFiles(log), ['test/authority-tier1-closure-310b.test.ts']);
  assert.deepEqual(failedTestFiles(' FAIL  real-io test/a.test.ts > case\n × unit test/b.test.ts\n'), ['test/a.test.ts', 'test/b.test.ts']);
  assert.deepEqual(failedTestFiles('\x1b[32m✓\x1b[39m \x1b[30m\x1b[42m unit \x1b[49m\x1b[39m test/passed.test.ts\n ✓ |unit| test/also-passed.test.ts\n'), []);
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
