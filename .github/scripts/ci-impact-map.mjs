// Read-only presentation of the existing immutable-source impact graph.
// Import reachability is useful context, not test-omission or release authority.
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function graph(rows) {
  assert.ok(Array.isArray(rows), 'input graph missing');
  const nodes = new Map(); const reverse = new Map();
  for (const row of rows) {
    assert.ok(text(row?.path) && Array.isArray(row.imports) && Array.isArray(row.unknown), 'invalid graph node');
    assert.ok(!nodes.has(row.path), 'duplicate graph node');
    assert.ok(row.unknown.every(text), 'invalid unknown reason');
    nodes.set(row.path, row);
  }
  for (const row of rows) {
    for (const edge of row.imports) {
      assert.ok(edge && (edge.target === null || text(edge.target)), 'invalid graph edge');
      if (edge.target === null) continue;
      assert.ok(nodes.has(edge.target), 'graph target missing');
      const parents = reverse.get(edge.target) ?? new Set(); parents.add(row.path); reverse.set(edge.target, parents);
    }
  }
  return { nodes, reverse };
}

function distances(start, reverse) {
  const seen = new Map([[start, 0]]); const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const path = queue[cursor];
    for (const parent of reverse.get(path) ?? []) {
      if (seen.has(parent)) continue;
      seen.set(parent, seen.get(path) + 1); queue.push(parent);
    }
  }
  return seen;
}

export function impactMap(shadow) {
  assert.equal(shadow?.schema, 'phantom-ci-impact-shadow/v1', 'unsupported shadow');
  assert.equal(shadow.advisoryOnly, true); assert.equal(shadow.activationEnabled, false);
  assert.ok(sha(shadow.source?.revision) && sha(shadow.source?.tree), 'source binding missing');
  assert.ok(Array.isArray(shadow.descriptors), 'test descriptors missing');
  const head = graph(shadow.inputs?.head); const base = graph(shadow.inputs?.base);
  const tests = new Map();
  for (const row of shadow.descriptors) {
    assert.ok(text(row?.module) && !tests.has(row.module), 'invalid test descriptor');
    assert.ok(row.complete === false && row.decision === 'full-required', 'unexpected selection policy');
    assert.ok(Array.isArray(row.reasons) && row.reasons.every(text), 'descriptor reasons missing');
    tests.set(row.module, row);
  }
  const baseAvailable = shadow.base?.sourceState === 'observed' && sha(shadow.base.revision) && sha(shadow.base.tree);
  assert.ok(shadow.changes === null || Array.isArray(shadow.changes), 'invalid change set');
  const changes = shadow.changes ?? [];
  assert.ok(changes.every((row) => text(row?.path)) && new Set(changes.map((row) => row.path)).size === changes.length,
    'invalid changed paths');
  const global = new Set((shadow.globalInputs ?? []).map((row) => row.path));
  const rows = changes.map(({ path, base: before, head: after }) => {
    // Keep old and current edges separate: combining them could invent a path
    // that never existed in either source tree.
    const current = distances(path, head.reverse); const previous = distances(path, base.reverse);
    const relationships = [];
    for (const module of tests.keys()) {
      const now = current.get(module); const prior = previous.get(module);
      if (now === undefined && prior === undefined) continue;
      relationships.push({ module, headDistance: now ?? null, baseDistance: prior ?? null,
        relation: module === path ? 'changed-test' : now === 1 || prior === 1 ? 'direct-import' : 'transitive-import' });
    }
    relationships.sort((a, b) => Math.min(a.headDistance ?? Infinity, a.baseDistance ?? Infinity) -
      Math.min(b.headDistance ?? Infinity, b.baseDistance ?? Infinity) || order(a.module, b.module));
    return { path, change: !before ? 'added' : !after ? 'deleted' : 'modified', globalInput: global.has(path),
      knownImportRelationships: relationships.length, otherModulesCoverageUnproven: tests.size - relationships.length,
      relationships };
  }).sort((a, b) => b.knownImportRelationships - a.knownImportRelationships || order(a.path, b.path));
  const reasons = [...new Set([...tests.values()].flatMap((row) => row.reasons))].sort(order);
  return { schema: 'phantom-ci-impact-map/v1', advisoryOnly: true, source: shadow.source,
    base: { revision: shadow.base?.revision ?? null, tree: shadow.base?.tree ?? null, available: Boolean(baseAvailable) },
    role: shadow.role, inventory: shadow.head?.outcome === 'executed-at-head' ? 'observed-role-modules' : 'unobserved-source-candidates',
    testModules: tests.size, changedPaths: shadow.changes === null ? null : rows.length,
    sourceTreesEqual: Boolean(baseAvailable && shadow.source.tree === shadow.base.tree),
    coverageComplete: false, ciPolicyChanged: false, testSelectionEnabled: false, inheritedCases: 0,
    timing: shadow.timing ?? null, reasons, rows };
}

const escape = (value) => String(value).replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function renderImpactMap(report) {
  assert.equal(report?.schema, 'phantom-ci-impact-map/v1');
  const max = report.rows.reduce((value, row) => Math.max(value, row.knownImportRelationships), 1);
  const rows = report.rows.map((row) => `<tr data-file="${escape(row.path)}"><td><details><summary>${escape(row.path)}</summary>
    <p>${escape(row.otherModulesCoverageUnproven)} other modules have unproven coverage. No test is omitted.</p>
    <ol>${row.relationships.map((item) => `<li><code>${escape(item.module)}</code> · ${escape(item.relation)}
    (current: ${escape(item.headDistance ?? 'none')}, previous: ${escape(item.baseDistance ?? 'none')})</li>`).join('')}</ol></details></td>
    <td>${escape(row.change)}${row.globalInput ? ' · shared input' : ''}</td>
    <td class="heat"><span style="width:${Math.round(row.knownImportRelationships / max * 100)}%"></span><b>${escape(row.knownImportRelationships)}</b></td>
    <td>${escape(row.otherModulesCoverageUnproven)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Phantom PR impact map</title><style>
    :root{font:15px/1.55 system-ui,sans-serif;color:#e7e9ed;background:#10151b;color-scheme:dark}body{max-width:1280px;margin:36px auto;padding:0 24px}
    h1{font-size:30px;letter-spacing:-.03em;margin-bottom:4px}p{color:#b8c2ce}code{font-size:12px;overflow-wrap:anywhere}
    .notice{border-left:3px solid #e4ac52;background:#222018;padding:12px 16px}.stats{display:flex;gap:32px;flex-wrap:wrap;margin:24px 0}
    .stats b{font-size:25px;display:block;color:#fff}.stats span{color:#a8b4c2}input{width:min(540px,90%);padding:10px;border:1px solid #465264;border-radius:5px;background:#17202a;color:inherit}
    table{border-collapse:collapse;width:100%;margin-top:20px}th,td{text-align:left;border-bottom:1px solid #303943;padding:12px;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#a9b7c7}
    td:first-child{width:55%;overflow-wrap:anywhere}summary{cursor:pointer}li{margin:8px 0}.heat{position:relative;min-width:85px}.heat span{position:absolute;height:24px;background:#9b4f2e;opacity:.5;left:0}.heat b{position:relative}
    footer{margin:32px 0;color:#a8b4c2}a{color:#99c9ff}@media(max-width:650px){body{padding:0 12px}.stats{gap:18px}th,td{padding:8px}h1{font-size:25px}}
    </style><h1>PR impact map</h1><p>Immutable source · ${escape(report.role)} · ${escape(report.inventory)}</p>
    <p><code>${escape(report.base.revision ?? 'unknown base')} → ${escape(report.source.revision)}</code></p>
    <div class="notice">Import relationships guide focused review. Coverage is incomplete; this map changes no CI policy or release decision.
    A missing import path does not prove a test is unrelated. Expand a file to inspect its known connections.</div>
    <div class="stats"><span><b>${escape(report.changedPaths ?? 'Unknown')}</b>changed paths</span><span><b>${escape(report.testModules)}</b>test modules</span>
    <span><b>${report.sourceTreesEqual ? 'Equal' : 'Different / unknown'}</b>source trees</span><span><b>0</b>inherited test results</span></div>
    <label for="filter">Find a changed file</label><p><input id="filter" type="search" placeholder="Filter paths…" autocomplete="off"></p>
    <table><thead><tr><th>Changed file</th><th>Change</th><th>Known import links</th><th>Other coverage unproven</th></tr></thead>
    <tbody>${rows}</tbody></table>${report.rows.length ? '' : '<p>No changed paths were reported. Base availability: '+escape(report.base.available)+'.</p>'}
    <footer>Counts refer to ${escape(report.inventory)}; source candidates are not executed coverage. Historical timing, when present in the JSON,
    is reporter span time, not CPU time or a measured speedup. No external assets or network requests are used by this view.</footer>
    <script>document.getElementById('filter').addEventListener('input',function(){const q=this.value.toLowerCase();for(const row of document.querySelectorAll('tr[data-file]'))row.hidden=!row.dataset.file.toLowerCase().includes(q)});</script></html>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, baseRevision, revision, role, format] = process.argv.slice(2);
    assert.ok(root && sha(baseRevision) && sha(revision) && role && (format === undefined || format === '--html'));
    const { collectShadow } = await import('./ci-impact-shadow.mjs');
    const result = impactMap(collectShadow({ root, baseRevision, revision, role, sourceOnly: true }));
    process.stdout.write(format === '--html' ? renderImpactMap(result) : JSON.stringify(result, null, 2) + '\n');
  } catch {
    console.error('Impact map unavailable; existing CI policy is unchanged. Usage: ci-impact-map.mjs ROOT BASE_SHA HEAD_SHA ROLE [--html]');
    process.exitCode = 1;
  }
}
