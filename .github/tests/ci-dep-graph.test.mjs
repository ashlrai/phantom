import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { affectedProjects, lintFiles, parseImports, resolveSpecifier, updateGraph } from '../scripts/ci-dep-graph.mjs';

test('parse and resolve relative imports, then update only changed files', () => {
  const files = new Set(['src/a.ts', 'src/b.ts', 'src/web-ui/app.ts']);
  assert.deepEqual(parseImports("import { b } from './b.js';\nexport type { T } from './a.js';\n"), ['./b.js', './a.js']);
  assert.equal(resolveSpecifier('src/web-ui/app.ts', '../a.js', files), 'src/a.ts');
  assert.equal(resolveSpecifier('test/uses.test.ts', '../src/a.js', new Set([...files, 'test/uses.test.ts'])), 'src/a.ts');
  assert.equal(resolveSpecifier('test/nested/uses.test.ts', '../../src/a.js', new Set([...files, 'test/nested/uses.test.ts'])), 'src/a.ts');
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

test('a non-literal import is recorded unresolved so selection can fail closed', () => {
  const graph = updateGraph(null, [
    { path: 'src/a.ts', hash: '1', text: 'export const load = (name) => import(`./${name}.js`);\n' },
    { path: 'src/b.ts', hash: '2', text: "const value = await import('./a.js');\nexport const b = value;\n" },
  ]).graph;
  assert.equal(graph.files['src/a.ts'].dynamic, true);
  assert.equal(graph.unknown, undefined);
  assert.deepEqual(graph.files['src/b.ts'].imports, ['src/a.ts']);
  assert.equal(graph.files['src/b.ts'].dynamic, undefined);
});

test('lint selection adds direct importers of a changed module', () => {
  const graph = updateGraph(null, [
    { path: 'src/a.ts', hash: '1', text: 'export const a = 1;\n' },
    { path: 'src/b.ts', hash: '2', text: "import { a } from './a.js';\n" },
  ]).graph;
  assert.deepEqual(lintFiles(['src/a.ts'], graph), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(lintFiles(['docs/guide.md'], graph), []);
});

test('update stamps HEAD and rebuilds edges from a graph outside this history', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-dep-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'ci');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.ts'), "import { b } from './b.js';\n");
  writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  const script = join(dirname(fileURLToPath(import.meta.url)), '../scripts/ci-dep-graph.mjs');
  const out = join(dir, 'dep-graph.json');
  const run = () => execFileSync(process.execPath, [script, 'update', '--out', out], { cwd: dir, encoding: 'utf8' });
  run();
  const first = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(first.commit, git('rev-parse', 'HEAD'));
  assert.equal(first.resolver, 2);
  assert.deepEqual(first.files['src/a.ts'].imports, ['src/b.ts']);
  assert.match(run(), /reused 2 files at /);
  first.commit = 'b'.repeat(40);
  first.files['src/a.ts'].imports = ['src/missing.ts'];
  writeFileSync(out, JSON.stringify(first));
  const logged = execFileSync(process.execPath, [script, 'update', '--out', out], { cwd: dir, encoding: 'utf8' });
  const rebuilt = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(rebuilt.commit, git('rev-parse', 'HEAD'));
  assert.deepEqual(rebuilt.files['src/a.ts'].imports, ['src/b.ts']);
  assert.match(logged, /2 reparsed/);
});
