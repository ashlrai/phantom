import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globalInputReason, parseShard, partition, selectTests, shardCommands } from '../scripts/ci-affected-tests.mjs';

const tree = {
  'src/core/a.ts': "export const a = 1;\n",
  'src/core/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
  'src/core/unrelated.ts': 'export const u = 1;\n',
  'src/web-ui/App.tsx': 'export const App = 1;\n',
  'test/b.test.ts': "import { b } from '../src/core/b.js';\n",
  'test/unrelated.test.ts': "import { u } from '../src/core/unrelated.js';\n",
  'test/authority-x.test.ts': "import { u } from '../src/core/unrelated.js';\n",
  'test/h1.fixture.test.ts': 'export {};\n',
  'test/m30.ci.test.ts': 'export {};\n',
  'test/reads-fixture.test.ts': "readFileSync(join(ROOT, 'test', 'fixtures', 'data', 'row.json'));\n",
  'test/needs-dist.test.ts': "import { x } from './helpers/require-built-dist.js';\nimport '../src/core/a.js';\n",
  'test/m342.dispatch-production-ledger.test.ts': "import '../src/core/a.js';\n",
  'test/fixtures/data/row.json': '{}\n',
  'README.md': '# readme\n',
  'package.json': '{}\n',
  '.github/scripts/ci-x.mjs': 'export {};\n',
  '.github/tests/ci-x.test.mjs': 'export {};\n',
};
const files = Object.keys(tree);
const read = (path) => tree[path] ?? null;
const select = (changed, extra = {}) => selectTests({ changed, files, read, markdownTests: () => ['test/unrelated.test.ts'], ...extra });

test('selects tests that transitively import a changed module, plus Tier-1', () => {
  const plan = select(['src/core/a.ts']);
  assert.equal(plan.mode, 'selected');
  assert.deepEqual(plan.tests, [
    'test/authority-x.test.ts', 'test/b.test.ts', 'test/h1.fixture.test.ts', 'test/m30.ci.test.ts', 'test/needs-dist.test.ts',
  ]);
  assert.deepEqual(plan.tier1, ['test/authority-x.test.ts', 'test/h1.fixture.test.ts', 'test/m30.ci.test.ts']);
  assert.equal(plan.buildNeeded, true);
});

test('an unrelated change still runs the Tier-1 set and nothing else', () => {
  const plan = select(['src/core/unrelated.ts']);
  assert.deepEqual(plan.tests, ['test/authority-x.test.ts', 'test/h1.fixture.test.ts', 'test/m30.ci.test.ts', 'test/unrelated.test.ts']);
  assert.equal(plan.buildNeeded, false);
});

test('a deleted module still selects its former importers', () => {
  const head = files.filter((path) => path !== 'src/core/a.ts');
  const plan = selectTests({ changed: ['src/core/a.ts'], files: head, read, markdownTests: () => [] });
  assert.ok(plan.tests.includes('test/needs-dist.test.ts'));
});

test('a changed data file selects tests that name it, including joined path segments', () => {
  const plan = select(['test/fixtures/data/row.json']);
  assert.ok(plan.tests.includes('test/reads-fixture.test.ts'));
});

test('a changed test selects itself', () => {
  assert.ok(select(['test/unrelated.test.ts']).tests.includes('test/unrelated.test.ts'));
});

test('Markdown edits add the docs checks and Markdown-reading suites', () => {
  const plan = select(['README.md']);
  assert.equal(plan.docs, true);
  assert.ok(plan.tests.includes('test/unrelated.test.ts'));
  assert.deepEqual(shardCommands(plan, { index: 1, total: 1 }).at(-1), ['npm', 'run', 'check:docs']);
});

test('global inputs fall back to the whole backend suite, minus daily-only tests', () => {
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'test/setup/home.ts', 'scripts/test-ci.mjs']) {
    assert.ok(globalInputReason(path), path);
  }
  const plan = select(['package.json']);
  assert.equal(plan.mode, 'full');
  assert.equal(plan.web, true);
  assert.ok(!plan.tests.includes('test/m342.dispatch-production-ledger.test.ts'));
  assert.equal(plan.tests.length, files.filter((path) => /^test\/.+\.test\.ts$/.test(path)).length - 1);
});

test('web changes run the web typecheck and suite once, on shard 1', () => {
  const plan = select(['src/web-ui/App.tsx']);
  assert.equal(plan.web, true);
  const first = shardCommands(plan, { index: 1, total: 3 }).map((command) => command.join(' '));
  assert.ok(first.includes('npm run typecheck:web') && first.includes('npm run test:web'));
  const second = shardCommands(plan, { index: 2, total: 3 }).map((command) => command.join(' '));
  assert.ok(!second.some((command) => /:web|check:docs/.test(command)));
});

test('workflow script and test changes run their node:test files on shard 1', () => {
  assert.deepEqual(select(['.github/scripts/ci-x.mjs']).nodeTests, ['.github/tests/ci-x.test.mjs']);
  assert.deepEqual(select(['.github/tests/ci-x.test.mjs']).nodeTests, ['.github/tests/ci-x.test.mjs']);
  assert.deepEqual(select(['.github/scripts/ghost.mjs']).nodeTests, []);
});

test('partitions cover every test exactly once', () => {
  const list = Array.from({ length: 10 }, (_, i) => `t${i}`);
  const parts = [1, 2, 3].map((index) => partition(list, index, 3));
  assert.deepEqual(parts.flat().sort(), [...list].sort());
  assert.equal(new Set(parts.flat()).size, list.length);
});

test('shard syntax is strict', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 });
  for (const bad of [undefined, '', '0/3', '4/3', 'a/b', '1/0', '1/3 ']) assert.throws(() => parseShard(bad), bad);
});
