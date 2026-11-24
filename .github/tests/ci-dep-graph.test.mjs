import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, affectedProjects, graphCoversCommit, lintFiles, normalizeGraph, parseImports, resolveSpecifier, updateGraph } from '../scripts/ci-dep-graph.mjs';

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

test('a graph pinned to HEAD is reused and a foreign pin is not', () => {
  const head = 'a'.repeat(40);
  const graph = normalizeGraph({ schema: SCHEMA, commit: head, files: { 'src/a.ts': { hash: '1', imports: [] } } });
  assert.equal(graph.commit, head);
  assert.equal(graphCoversCommit(graph, head), true);
  assert.equal(graphCoversCommit(graph, 'b'.repeat(40)), false);
  assert.equal(normalizeGraph({ schema: SCHEMA, commit: 'nope', files: { 'src/a.ts': { hash: '1', imports: [] } } }).commit, undefined);
  assert.equal(graphCoversCommit(normalizeGraph(null), head), false);
});

test('the second update of an unchanged checkout reuses the saved graph', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dep-graph-reuse-'));
  const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/ci-dep-graph.mjs');
  try {
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'ci'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', 'src/a.ts'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'a'], { cwd: dir });
    const out = join(dir, 'graph.json');
    const run = () => execFileSync('node', [script, 'update', '--out', out], { cwd: dir, encoding: 'utf8' });
    assert.match(run(), /1 files, 1 reparsed/);
    assert.match(run(), /reused 1 files at /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint selection adds direct importers of a changed module', () => {
  const graph = updateGraph(null, [
    { path: 'src/a.ts', hash: '1', text: 'export const a = 1;\n' },
    { path: 'src/b.ts', hash: '2', text: "import { a } from './a.js';\n" },
  ]).graph;
  assert.deepEqual(lintFiles(['src/a.ts'], graph), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(lintFiles(['docs/guide.md'], graph), []);
});
