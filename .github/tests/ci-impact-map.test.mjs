import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { impactMap, renderImpactMap } from '../scripts/ci-impact-map.mjs';

const node = (path, targets = []) => ({ path, imports: targets.map((target) => ({ target })), unknown: [] });
const descriptor = (module) => ({ module, complete: false, decision: 'full-required', reasons: ['coverage-unproven'] });
const fixture = () => ({ schema: 'phantom-ci-impact-shadow/v1', advisoryOnly: true, activationEnabled: false,
  source: { revision: 'a'.repeat(40), tree: 'b'.repeat(40) },
  base: { revision: 'c'.repeat(40), tree: 'd'.repeat(40), sourceState: 'observed' },
  role: 'mac-general-1', changes: [{ path: 'src/a.ts', base: {}, head: {} }], globalInputs: [],
  descriptors: [descriptor('test/a.test.ts'), descriptor('test/b.test.ts'), descriptor('test/c.test.ts')],
  inputs: { head: [node('src/a.ts'), node('src/b.ts', ['src/a.ts']), node('test/a.test.ts', ['src/a.ts']),
    node('test/b.test.ts', ['src/b.ts']), node('test/c.test.ts')], base: [] }, head: { outcome: 'unobserved' } });

test('map identifies direct/transitive connections without declaring other tests safe or selected', () => {
  const result = impactMap(fixture());
  assert.equal(result.rows[0].knownImportRelationships, 2);
  assert.equal(result.rows[0].otherModulesCoverageUnproven, 1);
  assert.deepEqual(result.rows[0].relationships, [
    { module: 'test/a.test.ts', headDistance: 1, baseDistance: null, relation: 'direct-import' },
    { module: 'test/b.test.ts', headDistance: 2, baseDistance: null, relation: 'transitive-import' },
  ]);
  assert.equal(result.inventory, 'unobserved-source-candidates');
  assert.equal(result.coverageComplete, false); assert.equal(result.ciPolicyChanged, false);
  assert.equal(result.testSelectionEnabled, false); assert.equal(result.inheritedCases, 0);
});

test('deleted sources retain old-tree connections and changed tests match themselves', () => {
  const shadow = fixture();
  shadow.inputs.base = [node('src/deleted.ts'), node('test/a.test.ts', ['src/deleted.ts'])];
  shadow.changes = [{ path: 'src/deleted.ts', base: {}, head: null }, { path: 'test/c.test.ts', base: {}, head: {} }];
  const result = impactMap(shadow);
  const deleted = result.rows.find((row) => row.path === 'src/deleted.ts');
  assert.equal(deleted.change, 'deleted');
  assert.deepEqual(deleted.relationships, [{ module: 'test/a.test.ts', headDistance: null, baseDistance: 1, relation: 'direct-import' }]);
  assert.equal(result.rows.find((row) => row.path === 'test/c.test.ts').relationships[0].relation, 'changed-test');
});

test('cycles terminate and edges from different versions never invent a connection', () => {
  const shadow = fixture();
  shadow.inputs.head = [node('src/a.ts'), node('src/b.ts', ['src/c.ts']), node('src/c.ts', ['src/b.ts']),
    node('test/a.test.ts', ['src/b.ts']), node('test/b.test.ts')];
  shadow.inputs.base = [node('src/a.ts'), node('src/b.ts', ['src/a.ts']), node('test/a.test.ts'), node('test/b.test.ts', ['src/b.ts'])];
  shadow.descriptors = [descriptor('test/a.test.ts'), descriptor('test/b.test.ts')];
  const result = impactMap(shadow);
  assert.deepEqual(result.rows[0].relationships, [
    { module: 'test/b.test.ts', headDistance: null, baseDistance: 2, relation: 'transitive-import' },
  ]);
  shadow.changes = [{ path: 'src/c.ts', base: null, head: {} }];
  assert.equal(impactMap(shadow).rows[0].relationships[0].headDistance, 2);
});

test('unknown base, no changes, observed inventory and global inputs remain explicit', () => {
  const shadow = fixture(); shadow.base = { sourceState: 'unavailable' }; shadow.changes = null;
  let result = impactMap(shadow);
  assert.equal(result.changedPaths, null); assert.equal(result.sourceTreesEqual, false); assert.deepEqual(result.rows, []);
  shadow.base = { revision: 'c'.repeat(40), tree: shadow.source.tree, sourceState: 'observed' }; shadow.changes = [];
  result = impactMap(shadow); assert.equal(result.sourceTreesEqual, true); assert.equal(result.changedPaths, 0);
  shadow.changes = [{ path: 'package-lock.json', base: {}, head: {} }];
  shadow.globalInputs = [{ path: 'package-lock.json' }]; shadow.head.outcome = 'executed-at-head';
  result = impactMap(shadow); assert.equal(result.rows[0].globalInput, true);
  assert.equal(result.inventory, 'observed-role-modules'); assert.equal(result.rows[0].otherModulesCoverageUnproven, 3);
});

test('malformed or duplicate graph/descriptors and selection claims refuse projection', () => {
  const mutations = [(s) => { s.activationEnabled = true; }, (s) => { s.source.revision = 'short'; },
    (s) => { s.inputs.head.push(s.inputs.head[0]); }, (s) => { s.inputs.head[0].imports = [{ target: 'missing' }]; },
    (s) => { s.descriptors.push(s.descriptors[0]); }, (s) => { s.descriptors[0].complete = true; },
    (s) => { s.descriptors[0].decision = 'omit'; }, (s) => { s.changes.push(s.changes[0]); }];
  for (const change of mutations) { const shadow = fixture(); change(shadow); assert.throws(() => impactMap(shadow)); }
});

test('rendered view escapes untrusted labels and contains no external assets', () => {
  const shadow = fixture(); const attack = '<img src=x onerror="alert(1)">';
  shadow.role = attack; shadow.changes[0].path = attack;
  shadow.descriptors = [descriptor(attack)]; shadow.inputs.head = [node(attack)];
  const html = renderImpactMap(impactMap(shadow));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script src=')); assert.ok(!html.includes('<link '));
  assert.ok(html.includes('type="search"')); assert.ok(html.includes('<details>'));
  assert.ok(html.includes('No test is omitted.'));
});

test('real immutable Git collector and CLI produce the map without changing the source checkout', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'impact-map-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'test/a.test.ts'), "import { a } from '../src/a.js';\nexport const value = a;\n");
    writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git('add', '.'); git('commit', '-qm', 'head'); const head = git('rev-parse', 'HEAD');
    const cli = fileURLToPath(new URL('../scripts/ci-impact-map.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [cli, root, base, head, 'mac-general-1'], { encoding: 'utf8', timeout: 30_000 });
    const result = JSON.parse(output);
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].relationships[0].module, 'test/a.test.ts');
    assert.equal(result.source.revision, head); assert.equal(result.base.revision, base);
    assert.equal(git('status', '--porcelain'), ''); assert.equal(git('rev-parse', 'HEAD'), head);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
