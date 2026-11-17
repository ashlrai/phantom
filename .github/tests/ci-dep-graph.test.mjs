import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedProjects, lintFiles, parseImports, resolveSpecifier, updateGraph } from '../scripts/ci-dep-graph.mjs';

test('parse and resolve relative imports, then update only changed files', () => {
  const files = new Set(['src/a.ts', 'src/b.ts', 'src/web-ui/app.ts']);
  assert.deepEqual(parseImports("import { b } from './b.js';\nexport type { T } from './a.js';\n"), ['./b.js', './a.js']);
  assert.equal(resolveSpecifier('src/web-ui/app.ts', '../a.js', files), 'src/a.ts');
  const first = updateGraph(null, [
    { path: 'src/a.ts', hash: '1', text: 'export const a = 1;\n' },
    { path: 'src/b.ts', hash: '2', text: "import { a } from './a.js';\n" },
    { path: 'src/web-ui/app.ts', hash: '3', text: "import { a } from '../a.js';\n" },
  ]);
  assert.equal(first.reparsed, 3);
  assert.deepEqual(first.graph.files['src/web-ui/app.ts'].imports, ['src/a.ts']);
  const next = updateGraph(first.graph, [
    { path: 'src/a.ts', hash: '1' },
    { path: 'src/b.ts', hash: '9', text: 'export const b = 2;\n' },
    { path: 'src/web-ui/app.ts', hash: '3' },
  ]);
  assert.equal(next.reparsed, 1);
  assert.deepEqual(next.graph.files['src/b.ts'].imports, []);
  assert.throws(() => updateGraph(first.graph, [{ path: 'src/a.ts', hash: '4' }]), /missing text/);
});

test('affected projects follow the graph and fail closed on an unknown module', () => {
  const graph = updateGraph(null, [
    { path: 'src/a.ts', hash: '1', text: 'export const a = 1;\n' },
    { path: 'src/web-ui/app.ts', hash: '3', text: "import { a } from '../a.js';\n" },
  ]).graph;
  assert.equal(affectedProjects(['docs/guide.md'], graph), 'none');
  assert.equal(affectedProjects(['src/web-ui/app.ts'], graph), 'web');
  assert.equal(affectedProjects(['src/a.ts'], graph), 'both');
  assert.equal(affectedProjects(['src/missing.ts'], graph), 'both');
  assert.equal(affectedProjects(['package-lock.json'], graph), 'both');
  assert.equal(affectedProjects(['README.md'], null), 'none');
  assert.equal(affectedProjects(['src/a.ts'], null), 'both');
  const unresolved = updateGraph(null, [
    { path: 'src/a.ts', hash: '1', text: "import { missing } from './missing.js';\n" },
    { path: 'src/web-ui/app.ts', hash: '3', text: 'export const app = 1;\n' },
  ]).graph;
  assert.equal(unresolved.unknown, true);
  assert.equal(affectedProjects(['src/a.ts'], unresolved), 'both');
  assert.equal(affectedProjects(['docs/guide.md'], unresolved), 'both');
});

test('lint selection adds direct importers of a changed module', () => {
  const graph = updateGraph(null, [
    { path: 'src/a.ts', hash: '1', text: 'export const a = 1;\n' },
    { path: 'src/b.ts', hash: '2', text: "import { a } from './a.js';\n" },
  ]).graph;
  assert.deepEqual(lintFiles(['src/a.ts'], graph), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(lintFiles(['docs/guide.md'], graph), []);
});
