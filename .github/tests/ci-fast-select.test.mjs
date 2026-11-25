import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { RESOLVER, updateGraph } from '../scripts/ci-dep-graph.mjs';
import {
  classifyPaths, plan, changedPaths, selectRelated, selectFallback, selectSmoke, loadSmokeSet,
  TIER1_TESTS, MAX_RELATED_TESTS, FALLBACK_SHARDS, SMOKE_SCHEMA,
} from '../scripts/ci-fast-select.mjs';
import { commandsFor, failedTestFiles, settleJobs, shardWorkers } from '../scripts/ci-fast-run.mjs';
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

function freshGraph(dir) {
  const head = sh(dir, 'rev-parse', 'HEAD');
  const listed = sh(dir, 'ls-files', '-z').split('\0').filter((file) => /^(?:src|test|scripts|desktop)\/.+\.[cm]?[jt]sx?$/.test(file));
  const entries = listed.map((path) => ({
    path,
    hash: sh(dir, 'rev-parse', `HEAD:${path}`),
    text: readFileSync(join(dir, path), 'utf8'),
  }));
  const { graph } = updateGraph(null, entries);
  graph.commit = head;
  graph.resolver = RESOLVER;
  return graph;
}

function planned(dir, paths, graph = freshGraph(dir)) {
  return plan({ cwd: dir, paths, graph, base: sh(dir, 'rev-parse', 'HEAD') });
}

const SMOKE_FILES = {
  '.github/fast-gate-smoke.json': `${JSON.stringify({
    schema: 'phantom-fast-gate-smoke.v1',
    version: 1,
    tests: ['test/authority-codeowners-310b.test.ts', 'test/authority-tier1-closure-310b.test.ts'],
  })}\n`,
  'test/authority-codeowners-310b.test.ts': 'export {};\n',
  'test/authority-tier1-closure-310b.test.ts': 'export {};\n',
};

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
  const r = planned(dir, ['src/core/beta.ts', 'test/unrelated.test.ts']);
  assert.equal(r.mode, 'related');
  assert.deepEqual(r.tests, ['test/unrelated.test.ts', 'test/uses-beta.test.ts']);
  const named = planned(dir, ['src/core/alpha.ts']);
  assert.deepEqual(named.tests, ['test/alpha.test.ts']);
  const missing = plan({ cwd: dir, paths: ['src/core/alpha.ts'] });
  assert.equal(missing.mode, 'fallback');
  assert.match(missing.reason, /dependency graph missing/);
});

test('dist-bound tests are deferred, not run without a build', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/gamma.ts': 'export {};\n',
    'test/gamma.test.ts': "import '../src/core/gamma.js';\n",
    'test/gamma-dist.test.ts': "import './helpers/require-built-dist.js';\nimport '../src/core/gamma.js';\n",
  });
  commit('seed');
  const r = planned(dir, ['src/core/gamma.ts']);
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

test('a code change with no graph falls back, and a fresh graph with no importers runs the smoke set', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/lonely.ts': 'export {};\n',
    'test/one.test.ts': 'export {};\n',
    ...SMOKE_FILES,
  });
  commit('seed');
  const missing = plan({ cwd: dir, paths: ['src/core/lonely.ts'] });
  assert.equal(missing.mode, 'fallback');
  assert.ok(missing.tests.includes('test/one.test.ts'));
  for (const name of TIER1_TESTS) assert.ok(missing.tests.includes(name), `fallback keeps ${name}`);
  const smoked = planned(dir, ['src/core/lonely.ts']);
  assert.equal(smoked.mode, 'smoke');
  assert.match(smoked.reason, /smoke v1/);
  assert.deepEqual(smoked.tests, [...TIER1_TESTS]);
  assert.ok(!smoked.tests.includes('test/one.test.ts'));
});

test('Tier-1 paths always add the named authority tests, even past the cap', (t) => {
  const files = { 'src/core/authority/protected-paths.ts': 'export {};\n' };
  for (const name of TIER1_TESTS) files[name] = "import '../src/core/authority/protected-paths.js';\n";
  for (let i = 0; i < MAX_RELATED_TESTS + 10; i += 1) files[`test/a-${String(i).padStart(3, '0')}.test.ts`] = "import '../src/core/authority/protected-paths.js';\n";
  const { dir, commit } = repo(t, files);
  commit('seed');
  const r = planned(dir, ['src/core/authority/protected-paths.ts']);
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
  const member = planned(dir, ['src/core/fleet/lane-console.ts']);
  assert.ok(member.tests.includes('test/authority-tier1-closure-310b.test.ts'), 'closure member diff runs the invariant');
  const snap = plan({ cwd: dir, paths: [snapshot] });
  assert.ok(snap.tests.includes('test/authority-tier1-closure-310b.test.ts'), 'snapshot regen runs the invariant');
  const other = planned(dir, ['src/core/fleet/unrelated.ts']);
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
    ...SMOKE_FILES,
  });
  commit('seed');
  // index.ts has no import edge into the suite — it parses the switch as
  // text — so only the named rule can select it.
  for (const path of ['src/cli/index.ts', 'src/cli/completions.ts', 'src/cli/help.ts']) {
    const r = planned(dir, [path]);
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

test('the first failing shard aborts the ones still running', async () => {
  const aborted = [];
  const runJob = (_command, args, signal) => new Promise((done) => {
    if (args[0] === 'fail') {
      setTimeout(() => done({ code: 1, log: 'fail' }), 15);
      return;
    }
    const timer = setTimeout(() => done({ code: 0, log: 'done' }), 500);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      aborted.push(args[0]);
      done({ code: 1, log: 'cancelled' });
    });
  });
  const results = await settleJobs([
    { command: 'node', args: ['fail'] },
    { command: 'node', args: ['slow'] },
  ], runJob);
  assert.equal(results[0].code, 1);
  assert.deepEqual(aborted, ['slow']);
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

test('a fresh graph follows transitive importers and keeps nearer tests under the cap', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/leaf.ts': 'export const leaf = 1;\n',
    'src/core/mid.ts': "import { leaf } from './leaf.js';\n",
    'test/mid.test.ts': "import '../src/core/mid.js';\n",
  });
  commit('seed');
  const reached = planned(dir, ['src/core/leaf.ts']);
  assert.equal(reached.mode, 'related');
  assert.deepEqual(reached.tests, ['test/mid.test.ts']);
});

test('near importers fill the cap before a transitive test', (t) => {
  const files = {
    'src/core/leaf.ts': 'export const leaf = 1;\n',
    'src/core/mid.ts': "import { leaf } from './leaf.js';\n",
    'test/mid.test.ts': "import '../src/core/mid.js';\n",
  };
  for (let i = 0; i < 30; i += 1) files[`test/leaf-${i}.test.ts`] = "import '../src/core/leaf.js';\n";
  const { dir, commit } = repo(t, files);
  commit('seed');
  const capped = selectRelated({ cwd: dir, paths: ['src/core/leaf.ts'], graph: freshGraph(dir) });
  assert.ok(capped.tests.includes('test/leaf-0.test.ts'));
  assert.ok(!capped.tests.includes('test/mid.test.ts'));
  assert.equal(capped.tests.length, MAX_RELATED_TESTS);
  assert.ok(capped.capped > 0);
});

test('colocated and transitively reached web tests are selected for the web runner', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/util.ts': 'export const u = 1;\n',
    'src/web-ui/Widget.tsx': "import { u } from '../core/util.js';\nexport const Widget = u;\n",
    'src/web-ui/Widget.test.tsx': "import { Widget } from './Widget.js';\n",
    'src/web-ui/Plain.tsx': 'export const plain = 1;\n',
    'src/web-ui/Plain.test.tsx': 'export {};\n',
    'test/util.test.ts': "import '../src/core/util.js';\n",
  });
  commit('seed');
  const reached = planned(dir, ['src/core/util.ts']);
  assert.equal(reached.mode, 'related');
  assert.deepEqual(reached.web, ['src/web-ui/Widget.test.tsx']);
  assert.ok(reached.tests.includes('test/util.test.ts'));
  const colocated = planned(dir, ['src/web-ui/Plain.tsx']);
  assert.equal(colocated.mode, 'related');
  assert.deepEqual(colocated.web, ['src/web-ui/Plain.test.tsx']);
  const changed = plan({ cwd: dir, paths: ['src/web-ui/Widget.test.tsx'] });
  assert.equal(changed.mode, 'related');
  assert.deepEqual(changed.web, ['src/web-ui/Widget.test.tsx']);
});

test('desktop component tests select into the web runner like src/web-ui suites', (t) => {
  const { dir, commit } = repo(t, {
    'desktop/fleet-map/map.ts': 'export const map = 1;\n',
    'desktop/fleet-map/map.test.ts': "import { map } from './map.js';\nimport { shared } from '../../src/core/shared.js';\nexport const seen = [map, shared];\n",
    'src/core/shared.ts': 'export const shared = 1;\n',
    'src/web-ui/uses-desktop.ts': "import { map } from '../../desktop/fleet-map/map.js';\nexport const uses = map;\n",
  });
  commit('seed');
  // Without the graph, selection degrades to fallback but still pins the
  // colocated suite for the web runner.
  const colocated = plan({ cwd: dir, paths: ['desktop/fleet-map/map.ts'], graph: null });
  assert.equal(colocated.mode, 'fallback');
  assert.deepEqual(colocated.web, ['desktop/fleet-map/map.test.ts']);
  // The import graph reaches the same suite, including through the
  // src/core module the desktop test imports (the real suite reads
  // src/core/graph/registry.js the same way).
  const reached = planned(dir, ['desktop/fleet-map/map.ts']);
  assert.equal(reached.mode, 'related');
  assert.deepEqual(reached.web, ['desktop/fleet-map/map.test.ts']);
  const viaCore = planned(dir, ['src/core/shared.ts']);
  assert.equal(viaCore.mode, 'related');
  assert.ok(viaCore.web.includes('desktop/fleet-map/map.test.ts'));
});

test('a v2 cache file without resolver 2 is rebuilt and then takes the narrow path', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/beta.ts': 'export const b = 1;\n',
    'test/beta.test.ts': "import '../src/core/beta.js';\n",
  });
  const head = commit('seed');
  const published = freshGraph(dir);
  delete published.resolver;
  published.files['test/beta.test.ts'] = { ...published.files['test/beta.test.ts'], imports: [] };
  const raw = plan({ cwd: dir, paths: ['src/core/beta.ts'], graph: published, base: head });
  assert.equal(raw.mode, 'fallback');
  assert.match(raw.reason, /unparsable/);
  const out = join(dir, 'dep-graph.json');
  writeFileSync(out, JSON.stringify(published));
  const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/ci-dep-graph.mjs');
  execFileSync(process.execPath, [script, 'update', '--out', out], { cwd: dir, encoding: 'utf8' });
  const restored = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(restored.schema, 'phantom-dep-graph.v1');
  assert.equal(restored.commit, head);
  assert.equal(restored.resolver, RESOLVER);
  assert.deepEqual(restored.files['test/beta.test.ts'].imports, ['src/core/beta.ts']);
  const selected = plan({ cwd: dir, paths: ['src/core/beta.ts'], graph: restored, base: head });
  assert.equal(selected.mode, 'related');
  assert.deepEqual(selected.tests, ['test/beta.test.ts']);
});

test('stale, unparsable, and dynamic graphs fall back toward the broader set', (t) => {
  const { dir, commit } = repo(t, {
    'src/core/beta.ts': 'export const b = 1;\n',
    'src/core/dyn.ts': 'export const load = (name) => import(`./${name}.js`);\n',
    'test/beta.test.ts': "import '../src/core/beta.js';\n",
    'README.md': '# base\n',
  });
  const base = commit('base');
  const graph = freshGraph(dir);
  commit('docs', { 'README.md': '# next\n' });
  const ancestor = plan({ cwd: dir, paths: ['src/core/beta.ts'], graph, base });
  assert.equal(ancestor.mode, 'related');
  assert.deepEqual(ancestor.tests, ['test/beta.test.ts']);
  const stale = plan({ cwd: dir, paths: ['src/core/beta.ts'], graph: { ...graph, commit: 'b'.repeat(40) }, base });
  assert.equal(stale.mode, 'fallback');
  assert.match(stale.reason, /not an ancestor of the base/);
  const shifted = freshGraph(dir);
  shifted.files['src/core/beta.ts'] = { ...shifted.files['src/core/beta.ts'], hash: '0'.repeat(40) };
  const mismatch = plan({ cwd: dir, paths: ['src/core/beta.ts'], graph: shifted, base });
  assert.equal(mismatch.mode, 'fallback');
  assert.match(mismatch.reason, /hash does not match HEAD/);
  const broken = plan({ cwd: dir, paths: ['src/core/beta.ts'], graph: { schema: 'nope', files: {} }, base });
  assert.equal(broken.mode, 'fallback');
  assert.match(broken.reason, /unparsable/);
  const dynamic = planned(dir, ['src/core/dyn.ts']);
  assert.equal(dynamic.mode, 'fallback');
  assert.match(dynamic.reason, /dynamic import in src\/core\/dyn.ts/);
  assert.ok(dynamic.tests.includes('test/beta.test.ts'));
});

test('a smoke file cannot drop Tier-1 suites, and secret-shape paths still select them', (t) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const checked = loadSmokeSet(root);
  assert.equal(checked.ok, true);
  assert.equal(checked.version, 1);
  assert.equal(JSON.parse(readFileSync(join(root, '.github/fast-gate-smoke.json'), 'utf8')).schema, SMOKE_SCHEMA);
  for (const name of TIER1_TESTS) assert.ok(checked.tests.includes(name), name);
  for (const name of ['test/cli-reference-drift.test.ts', 'test/fleet-lane-console.test.ts']) {
    assert.ok(!checked.tests.includes(name), name);
  }
  const selected = selectSmoke({ cwd: root });
  for (const name of TIER1_TESTS) assert.ok(selected.tests.includes(name), name);
  const { dir, commit } = repo(t, {
    'src/core/lonely.ts': 'export {};\n',
    'src/core/seen.ts': 'export const s = 1;\n',
    'test/seen.test.ts': "import '../src/core/seen.js';\n",
    'test/one.test.ts': 'export {};\n',
    '.github/tests/secret-shape/scrub.pl': '1\n',
    '.github/fast-gate-smoke.json': `${JSON.stringify({ schema: SMOKE_SCHEMA, version: 1, tests: ['test/one.test.ts'] })}\n`,
    ...Object.fromEntries(TIER1_TESTS.map((name) => [name, 'export {};\n'])),
  });
  commit('seed');
  const smoked = planned(dir, ['src/core/lonely.ts']);
  assert.equal(smoked.mode, 'smoke');
  for (const name of TIER1_TESTS) assert.ok(smoked.tests.includes(name), name);
  assert.ok(smoked.tests.includes('test/one.test.ts'));
  const mixed = planned(dir, ['src/core/seen.ts', 'src/core/lonely.ts']);
  assert.equal(mixed.mode, 'related');
  assert.ok(mixed.tests.includes('test/seen.test.ts'));
  for (const name of TIER1_TESTS) assert.ok(mixed.tests.includes(name), name);
  const shape = plan({ cwd: dir, paths: ['.github/tests/secret-shape/scrub.pl'] });
  assert.equal(shape.mode, 'related');
  for (const name of TIER1_TESTS) assert.ok(shape.tests.includes(name), `secret-shape keeps ${name}`);
});

test('web failures are named and web tests run under the web vitest config', () => {
  assert.deepEqual(failedTestFiles(' FAIL  console src/web-ui/Widget.test.tsx > renders\n'), ['src/web-ui/Widget.test.tsx']);
  const jobs = commandsFor({
    mode: 'related',
    tests: ['test/a.test.ts'],
    web: ['src/web-ui/Widget.test.tsx'],
    node: ['.github/tests/a.test.mjs'],
    shards: [],
  });
  assert.deepEqual(jobs.map((job) => job.args), [
    ['scripts/test-ci.mjs', '--bail=1', 'test/a.test.ts'],
    ['scripts/test-ci.mjs', '--bail=1', '--config', 'vitest.config.web.ts', 'src/web-ui/Widget.test.tsx'],
    ['--test', '.github/tests/a.test.mjs'],
  ]);
  const smoke = commandsFor({ mode: 'smoke', tests: [...TIER1_TESTS], web: [], node: [], shards: [] });
  assert.deepEqual(smoke.map((job) => job.args), [['scripts/test-ci.mjs', '--bail=1', ...TIER1_TESTS]]);
  const fallback = commandsFor({
    mode: 'fallback',
    tests: ['test/a.test.ts', 'test/b.test.ts'],
    web: ['src/web-ui/Widget.test.tsx'],
    node: [],
    shards: [['test/a.test.ts'], [], ['test/b.test.ts']],
  }, 4);
  assert.equal(fallback.length, 3);
  assert.ok(fallback[0].args.includes('--maxWorkers=2'));
  assert.ok(fallback[0].args.includes('--bail=1'));
  assert.deepEqual(fallback[2].args, ['scripts/test-ci.mjs', '--bail=1', '--config', 'vitest.config.web.ts', 'src/web-ui/Widget.test.tsx']);
});
