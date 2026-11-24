#!/usr/bin/env node
/* global process, console */
// Fast-gate test selection (RQ-CI-FASTGATE-1). Pure policy plus a thin git CLI.
//
// The fast gate must finish in about a minute, so it runs a bounded set of
// tests instead of an uncapped `vitest related` walk. When the precomputed
// import graph is fresh, selection is the transitive reverse-import closure
// of the changed sources (nearest tests first), plus colocated web tests,
// capped at MAX_RELATED_TESTS. A changed source the graph shows as having no
// importers and no colocated test runs the versioned smoke set instead of a
// stride sample. The exhaustive suites stay on the master schedule.
//
// Modes: docs (doc-reading tests, see selectDocs), related (selected tests),
// smoke (the fixed smoke set), fallback (a bounded broader set). Nothing
// ever skips tests silently: a missing, stale, or unparsable graph, a global
// input, or a dynamic import the graph cannot resolve resolves to fallback.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedPaths } from './ci-changed-paths.mjs';
import { RESOLVER, SCHEMA as GRAPH_SCHEMA } from './ci-dep-graph.mjs';
import { DOCS_ONLY_PATH_PATTERNS } from './ci-site-lane.mjs';
import { REAL_IO_TEST_FILES } from '../../test/config/realio-lane-membership.mjs';
import { SERIAL_CPU_TEST_FILES } from '../../test/config/serial-cpu-lane-membership.mjs';

export const MAX_RELATED_TESTS = 25;
export const FALLBACK_SHARDS = 3;
export const FALLBACK_TESTS_PER_SHARD = 40;

// Global inputs: a change here can alter every test, so selection by import
// edge is meaningless. These mirror the globalInputs of ci-impact-policy.
const GLOBAL_INPUT = [
  /^package(?:-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^src\/web-ui\/tsconfig[^/]*\.json$/,
  /^vite(?:st)?\.config[^/]*$/,
  /^vitest\.config[^/]*$/,
  /^test\/setup\//,
  /^test\/config\//,
  /^scripts\/test-ci[^/]*\.mjs$/,
];

// Tier-1 and security paths. A change here always adds the named tests, so the
// gate never runs fewer of them than the advisory quick job does today.
export const TIER1_TESTS = Object.freeze([
  'test/authority-codeowners-310b.test.ts',
  'test/authority-tier1-closure-310b.test.ts',
]);
const PACKAGE_FILES_TEST = 'test/package-files-allowlist.test.ts';
// The recorded Tier-1 authority import closure. Any member — or the snapshot
// itself — can grow the closure the guard test protects without touching a
// Tier-1 path, and no test file imports it, so selection names it directly.
export const TIER1_CLOSURE_SNAPSHOT = 'test/fixtures/authority/tier1-closure.json';
export const TIER1_CLOSURE_TEST = 'test/authority-tier1-closure-310b.test.ts';
// Prefixes where a brand-new file becomes a closure root (the `/**` and `*`
// entries of TIER1_SOURCE_PATTERNS in src/core/authority/protected-paths.ts;
// src/core/authority/ itself is already a TIER1_PATH). Every existing file
// under them is already a recorded member, so these only fire on new files —
// exactly the diffs that can grow the closure without touching a member.
// New exact-file roots require editing protected-paths.ts, itself Tier-1.
const CLOSURE_ROOT_PATH = [
  /^src\/core\/(?:memory|desktop|website|sandbox|policy|routing|improve|autopilot)\//,
  /^src\/core\/local-eval\/memory-/,
  /^src\/core\/daemon\/outcome-/,
  /^src\/core\/goals\/outcome-/,
  /^src\/core\/verse\/outcomes-/,
  /^src\/core\/resources\/pool-commissioning/,
];
const TIER1_PATH = [
  /^\.github\/CODEOWNERS$/,
  /^src\/core\/authority\//,
  /^test\/authority-[^/]*310b[^/]*\.test\.ts$/,
  /^\.github\/tests\/secret-shape\//,
];
// The three files test/cli-registry-drift.test.ts diffs against each other:
// the dispatch switch it parses as text, plus the two registries it imports.
const CLI_REGISTRY_TEST = 'test/cli-registry-drift.test.ts';
const CLI_REGISTRY_PATH = /^src\/cli\/(?:index|completions|help)\.ts$/;

// Slow lanes stay out of the derived and fallback sets: real-io suites spawn git,
// npm and daemons (a 34-file related run measured over two minutes locally) and
// serial-cpu suites run one at a time. Tests that need a built dist/ cannot run
// without a build. All of them keep running in the master full suites.
const SLOW = new Set([...REAL_IO_TEST_FILES, ...SERIAL_CPU_TEST_FILES]);
const distBoundCache = new Map();

function distBoundFiles(cwd) {
  if (distBoundCache.has(cwd)) return distBoundCache.get(cwd);
  let out = '';
  try {
    // One search of the commit. Per-file `git show` on a sparse checkout
    // fetches every test blob on its own and stalls the warm select step.
    out = git(cwd, ['grep', '-l', '-F', 'require-built-dist', 'HEAD', '--', 'test']);
  } catch (error) {
    if (error.status !== 1) {
      distBoundCache.set(cwd, null);
      return null;
    }
  }
  const files = new Set(out.split('\n').filter(Boolean).map((file) => file.replace(/^HEAD:/, '')));
  distBoundCache.set(cwd, files);
  return files;
}

export function needsDist(cwd, file) {
  let text = '';
  try {
    text = readFileSync(resolve(cwd, file), 'utf8');
  } catch {
    // A sparse checkout has not materialized the file. Read the blob. An
    // unreadable test stays out of the fast set.
    try { text = execFileSync('git', ['show', `HEAD:${file}`], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
    catch { return true; }
  }
  return /require-built-dist/.test(text);
}
const TEST_FILE = /^test\/(?:[^/]+\/)*[^/]+\.test\.ts$/;
const SOURCE_FILE = /^(?:src|test)\/.+\.(?:ts|tsx|mjs|js)$/;
const WEB_TEST = /^src\/web-ui\/(?:[^/]+\/)*[^/]+\.test\.(?:ts|tsx)$/;
const WEB_IMPL = /^src\/web-ui\/.+\.(?:ts|tsx)$/;
export const SMOKE_SCHEMA = 'phantom-fast-gate-smoke.v1';
export const SMOKE_SET_PATH = '.github/fast-gate-smoke.json';

function isSource(path) {
  return SOURCE_FILE.test(path) && !TEST_FILE.test(path) && !WEB_TEST.test(path);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}

export function isDocsOnly(paths) {
  return paths.length > 0 && paths.every((p) => DOCS_ONLY_PATH_PATTERNS.some((re) => re.test(p)));
}

export function classifyPaths(paths) {
  if (paths.length === 0) return { mode: 'docs', reason: 'empty diff' };
  if (isDocsOnly(paths)) return { mode: 'docs', reason: 'docs-only diff' };
  const global = paths.find((p) => GLOBAL_INPUT.some((re) => re.test(p)));
  if (global) return { mode: 'fallback', reason: `global input changed: ${global}` };
  return { mode: 'related', reason: 'changed sources' };
}

// Extra named tests for workflow and script edits, computed from paths only.
export function domainTests(paths, existing) {
  const tests = new Set();
  const node = new Set();
  if (paths.some((p) => TIER1_PATH.some((re) => re.test(p)))) for (const t of TIER1_TESTS) tests.add(t);
  if (paths.includes('.github/workflows/ci.yml') && existing.has('test/m30.ci.test.ts')) tests.add('test/m30.ci.test.ts');
  // The CLI registry anti-drift suite parses src/cli/index.ts's dispatch
  // switch as text — deliberately no import edge — so a diff that only
  // touches the switch gives related selection nothing to follow. Name it
  // for the whole registry surface it guards; an unregistered dispatch once
  // reached master and held every release-gate run red for hours.
  if (paths.some((p) => CLI_REGISTRY_PATH.test(p)) && existing.has(CLI_REGISTRY_TEST)) tests.add(CLI_REGISTRY_TEST);
  for (const p of paths) {
    const m = /^\.github\/(?:scripts\/([^/]+)\.mjs|tests\/([^/]+)\.test\.mjs)$/.exec(p);
    const stem = m?.[1] ?? m?.[2];
    if (stem && existing.has(`.github/tests/${stem}.test.mjs`)) node.add(`.github/tests/${stem}.test.mjs`);
  }
  return { tests: [...tests], node: [...node] };
}

// Members of the recorded Tier-1 closure, read from the committed snapshot.
// An unreadable snapshot yields an empty set: the diff's own paths still
// decide, and the full lane keeps the invariant regardless.
export function tier1ClosureMembers(cwd) {
  try {
    const parsed = JSON.parse(git(cwd, ['show', `HEAD:${TIER1_CLOSURE_SNAPSHOT}`]));
    return new Set(Array.isArray(parsed?.closure) ? parsed.closure.filter((p) => typeof p === 'string') : []);
  } catch {
    return new Set();
  }
}

// Direct importers of a module, found without building a graph: any test file
// whose text names the module path or an exact `/<stem>.js` specifier.
function importersOf(cwd, path, testFiles) {
  const noExt = path.replace(/\.(?:ts|tsx|mjs|js)$/, '');
  const stem = noExt.split('/').pop();
  const needles = [`${noExt}.js`, `${noExt}.ts`, `/${stem}.js'`, `/${stem}.js"`];
  const hits = new Set();
  for (const needle of needles) {
    let out = '';
    try {
      out = git(cwd, ['grep', '-l', '-F', '-e', needle, '--', 'test']);
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = no match
    }
    for (const f of out.split('\n')) if (testFiles.has(f)) hits.add(f);
  }
  return hits;
}

function isAncestor(cwd, ancestor, descendant) {
  if (!/^[0-9a-f]{40}$/.test(ancestor) || !/^[0-9a-f]{40}$/.test(descendant)) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    // Exit 1 is "not an ancestor". Exit 128 is an unknown object. Both mean
    // the graph was not built from this base, so selection fails closed.
    return false;
  }
}

function blobHash(cwd, path) {
  return git(cwd, ['rev-parse', `HEAD:${path}`]).trim();
}

// A graph is fresh when it parses as phantom-dep-graph.v1, names the commit
// it was built from, carries resolver 2, that commit is HEAD or an ancestor
// of the PR base, and every changed source's blob hash matches HEAD.
// Anything else fails closed.
export function assessGraph({ cwd, graph, base, sources }) {
  if (!graph) return { ok: false, reason: 'dependency graph missing' };
  if (graph.schema !== GRAPH_SCHEMA || !graph.files || typeof graph.files !== 'object' || Array.isArray(graph.files)) {
    return { ok: false, reason: 'dependency graph unparsable' };
  }
  if (graph.resolver !== RESOLVER) return { ok: false, reason: 'dependency graph unparsable' };
  const commit = typeof graph.commit === 'string' && /^[0-9a-f]{40}$/.test(graph.commit) ? graph.commit : '';
  if (!commit) return { ok: false, reason: 'dependency graph unparsable' };
  let head = '';
  try { head = git(cwd, ['rev-parse', 'HEAD']).trim(); }
  catch (error) { return { ok: false, reason: `dependency graph freshness check failed: ${error.message}` }; }
  if (commit !== head) {
    const baseSha = typeof base === 'string' && /^[0-9a-f]{40}$/.test(base) ? base : '';
    if (!baseSha || !isAncestor(cwd, commit, baseSha)) {
      return { ok: false, reason: `dependency graph is stale: ${commit} is not an ancestor of the base` };
    }
  }
  for (const path of sources) {
    const node = graph.files[path];
    if (!node || typeof node.hash !== 'string') return { ok: false, reason: `dependency graph is missing ${path}` };
    let blob = '';
    try { blob = blobHash(cwd, path); }
    catch { return { ok: false, reason: `dependency graph is missing ${path}` }; }
    if (node.hash !== blob) return { ok: false, reason: `dependency graph is stale: ${path} hash does not match HEAD` };
    if (node.dynamic === true) return { ok: false, reason: `dynamic import in ${path}` };
    if (Array.isArray(node.unresolved) && node.unresolved.length > 0) {
      return { ok: false, reason: `unresolved import in ${path}` };
    }
  }
  return { ok: true, reason: commit === head ? 'graph built from HEAD' : 'graph built from an ancestor of the base' };
}

function webTests(cwd) {
  return new Set(git(cwd, ['ls-files', '-z', '--', 'src/web-ui']).split('\0').filter((file) => WEB_TEST.test(file)));
}

function colocatedWeb(path, files) {
  if (!WEB_IMPL.test(path) || WEB_TEST.test(path)) return [];
  const stem = path.replace(/\.(?:ts|tsx)$/, '');
  const found = [];
  for (const ext of ['.test.tsx', '.test.ts']) {
    const file = `${stem}${ext}`;
    if (files.has(file)) found.push(file);
  }
  return found;
}

function reverseReach(graph, sources) {
  const reverse = new Map();
  for (const [file, node] of Object.entries(graph.files)) {
    for (const imported of node.imports ?? []) {
      const list = reverse.get(imported);
      if (list) list.push(file);
      else reverse.set(imported, [file]);
    }
  }
  const distance = new Map();
  const queue = sources.map((file) => ({ file, distance: 0 }));
  const seen = new Set(sources);
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const next of reverse.get(current.file) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const step = current.distance + 1;
      queue.push({ file: next, distance: step });
      distance.set(next, step);
    }
  }
  return distance;
}

function sourceHasTest(graph, source, files) {
  if (colocatedWeb(source, files).length > 0) return true;
  for (const file of reverseReach(graph, [source]).keys()) {
    if (TEST_FILE.test(file) || WEB_TEST.test(file)) return true;
  }
  return false;
}

export function loadSmokeSet(cwd) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(cwd, SMOKE_SET_PATH), 'utf8'));
  } catch (error) {
    return { ok: false, reason: `smoke set unreadable: ${error.message}` };
  }
  if (!parsed || parsed.schema !== SMOKE_SCHEMA || !Number.isInteger(parsed.version) || parsed.version < 1) {
    return { ok: false, reason: 'smoke set unparsable' };
  }
  if (!Array.isArray(parsed.tests) || parsed.tests.some((item) => typeof item !== 'string' || !TEST_FILE.test(item))) {
    return { ok: false, reason: 'smoke set unparsable' };
  }
  return { ok: true, version: parsed.version, tests: parsed.tests };
}

// Fixed set for a changed source the fresh graph cannot see a test for.
// Tier-1 suites are unioned in, so a smoke file cannot drop them.
export function selectSmoke({ cwd }) {
  const loaded = loadSmokeSet(cwd);
  if (!loaded.ok) return loaded;
  const dist = distBoundFiles(cwd);
  const existing = new Set(git(cwd, ['ls-files', '-z', '--', 'test']).split('\0').filter(Boolean));
  const ordered = [];
  for (const file of [...TIER1_TESTS, ...loaded.tests]) {
    if (ordered.includes(file) || !existing.has(file) || SLOW.has(file)) continue;
    if (dist ? dist.has(file) : needsDist(cwd, file)) continue;
    ordered.push(file);
  }
  for (const file of TIER1_TESTS) {
    if (existing.has(file) && !ordered.includes(file)) return { ok: false, reason: `smoke set dropped ${file}` };
  }
  return { ok: true, version: loaded.version, tests: ordered, web: [], node: [], shards: [], capped: 0, deferred: [] };
}

// `cap` defaults to the fast-gate budget. Preflight passes a larger cap; the
// fast gate keeps MAX_RELATED_TESTS. Changed tests and named Tier-1 tests are
// pinned and are never cut below that count. When `graph` covers every changed
// source, tests are the transitive reverse-import closure, nearest first.
// Otherwise git grep finds direct importers, the same set preflight uses.
export function selectRelated({ cwd, paths, cap = MAX_RELATED_TESTS, graph = null }) {
  const testFiles = new Set(git(cwd, ['ls-files', '-z', '--', 'test']).split('\0').filter((f) => TEST_FILE.test(f)));
  const webFiles = webTests(cwd);
  const existing = new Set(git(cwd, ['ls-files', '-z', '--', '.github/tests', 'test']).split('\0'));
  const alive = paths.filter((p) => existing.has(p) || git(cwd, ['ls-files', '--', p]).trim() !== '');
  const ranked = [];
  const web = [];
  const deferred = [];
  const add = (file, derived = false, into = ranked) => {
    if (ranked.includes(file) || web.includes(file) || deferred.includes(file)) return false;
    const known = into === web ? webFiles.has(file) : testFiles.has(file);
    if (!known) return false;
    if (needsDist(cwd, file) || (derived && SLOW.has(file) && !TIER1_TESTS.includes(file))) {
      deferred.push(file);
      return false;
    }
    into.push(file);
    return true;
  };
  for (const p of alive) if (TEST_FILE.test(p)) add(p); // changed tests first
  for (const p of alive) if (WEB_TEST.test(p)) add(p, false, web);
  const domain = domainTests(paths, existing);
  for (const t of domain.tests) add(t); // named Tier-1 tests are never capped away
  // A diff touching a recorded closure member — the snapshot itself, or a
  // prefix where a new file becomes a root — can grow the authority import
  // closure without touching a Tier-1 path, and no test file imports it, so
  // the invariant runs by name on exactly those diffs.
  const closure = tier1ClosureMembers(cwd);
  if (paths.some((p) => p === TIER1_CLOSURE_SNAPSHOT || closure.has(p) || CLOSURE_ROOT_PATH.some((re) => re.test(p)))) {
    add(TIER1_CLOSURE_TEST);
  }
  const sources = alive.filter((p) => isSource(p));
  for (const p of sources) for (const file of colocatedWeb(p, webFiles)) add(file, false, web);
  const pinned = ranked.length + web.length;
  const covered = graph?.schema === GRAPH_SCHEMA && graph.files && sources.every((p) => graph.files[p]);
  const orphans = [];
  if (covered && sources.length > 0) {
    const distance = reverseReach(graph, sources);
    const derived = [];
    const seen = new Set([...ranked, ...web, ...deferred]);
    for (const p of sources) {
      const stem = p.replace(/\.(?:ts|tsx|mjs|js)$/, '').split('/').pop();
      for (const file of testFiles) {
        if (!file.endsWith(`/${stem}.test.ts`) || seen.has(file)) continue;
        derived.push({ file, web: false, distance: 1_000_000 });
        seen.add(file);
      }
    }
    for (const [file, step] of distance) {
      const asWeb = WEB_TEST.test(file);
      if (!asWeb && !testFiles.has(file)) continue;
      const prior = derived.find((item) => item.file === file);
      if (prior) {
        if (step < prior.distance) prior.distance = step;
        continue;
      }
      if (seen.has(file)) continue;
      derived.push({ file, web: asWeb, distance: step });
      seen.add(file);
    }
    derived.sort((a, b) => a.distance - b.distance || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const limit = Math.max(cap, pinned);
    let used = pinned;
    let capped = 0;
    for (const item of derived) {
      if (used >= limit) { capped += 1; continue; }
      if (add(item.file, true, item.web ? web : ranked)) used += 1;
    }
    for (const source of sources) if (!sourceHasTest(graph, source, webFiles)) orphans.push(source);
    return { tests: ranked, web, capped, deferred, node: domain.node, orphans };
  }
  for (const p of sources) {
    const stem = p.replace(/\.(?:ts|tsx|mjs|js)$/, '').split('/').pop();
    for (const f of testFiles) if (f.endsWith(`/${stem}.test.ts`)) add(f, true); // name-matched
  }
  const importers = new Set();
  for (const p of sources) for (const f of importersOf(cwd, p, testFiles)) importers.add(f);
  for (const f of [...importers].sort()) add(f, true);
  // Pins sit at the front of `ranked`. Web pins stay outside this budget so
  // a git-grep selection keeps the same unit cap it had before web tests.
  const limit = Math.max(cap, pinned - web.length);
  return {
    tests: ranked.slice(0, limit),
    web,
    capped: Math.max(0, ranked.length - limit),
    deferred,
    node: domain.node,
    orphans,
  };
}

// A docs diff has no import edges, so related selection finds nothing — but
// suites that read pages as text can still fail. The whole-tree link guard
// always runs; every other suite whose source names a changed path (full
// repo-relative path first, then bare basename for join()-style readers) is
// added through the same dist/slow filters and cap as related selection.
export const DOCS_TREE_TESTS = Object.freeze(['test/docs-repo-links.test.ts']);

function docReaderTests(cwd, needles) {
  if (needles.length === 0) return [];
  let out = '';
  try {
    out = git(cwd, ['grep', '-l', '-F', ...needles.flatMap((n) => ['-e', n]), 'HEAD', '--', 'test']);
  } catch (error) {
    if (error.status !== 1) throw error; // 1 = no match
  }
  return out.split('\n').filter(Boolean).map((f) => f.replace(/^HEAD:/, '')).filter((f) => TEST_FILE.test(f)).sort();
}

export function selectDocs({ cwd, paths }) {
  const testFiles = new Set(git(cwd, ['ls-files', '-z', '--', 'test']).split('\0').filter((f) => TEST_FILE.test(f)));
  const ranked = [];
  const deferred = [];
  const add = (f, derived = false) => {
    if (!testFiles.has(f) || ranked.includes(f) || deferred.includes(f)) return;
    if (needsDist(cwd, f) || (derived && SLOW.has(f))) { deferred.push(f); return; }
    ranked.push(f);
  };
  for (const t of DOCS_TREE_TESTS) add(t);
  const pinned = ranked.length;
  const full = [...new Set(paths)].sort();
  const base = [...new Set(full.map((p) => p.split('/').pop()).filter((b) => b && !full.includes(b)))].sort();
  for (const f of docReaderTests(cwd, full)) add(f, true);
  for (const f of docReaderTests(cwd, base)) add(f, true);
  const limit = Math.max(MAX_RELATED_TESTS, pinned);
  return { tests: ranked.slice(0, limit), capped: Math.max(0, ranked.length - limit), deferred, node: [] };
}

// Bounded broader set: every Tier-1 test plus an even, deterministic spread of
// the repository's test files, split round-robin so shards have equal counts.
export function selectFallback({ cwd, requiredTests = [] }) {
  const dist = distBoundFiles(cwd);
  const all = git(cwd, ['ls-files', '-z', '--', 'test']).split('\0')
    .filter((f) => TEST_FILE.test(f) && !SLOW.has(f) && (dist ? !dist.has(f) : !needsDist(cwd, f))).sort();
  const budget = FALLBACK_SHARDS * FALLBACK_TESTS_PER_SHARD;
  const step = Math.max(1, Math.ceil(all.length / budget));
  const picked = new Set([...TIER1_TESTS, ...requiredTests].filter((t) => all.includes(t)));
  for (let i = 0; i < all.length && picked.size < budget; i += step) picked.add(all[i]);
  const list = [...picked].sort();
  const shards = Array.from({ length: FALLBACK_SHARDS }, () => []);
  list.forEach((f, i) => shards[i % FALLBACK_SHARDS].push(f));
  return { tests: list, shards, node: [] };
}

export { changedPaths };

function pinnedWeb(paths, files) {
  const web = [];
  for (const path of paths) {
    if (WEB_TEST.test(path) && files.has(path) && !web.includes(path)) web.push(path);
    for (const file of colocatedWeb(path, files)) if (!web.includes(file)) web.push(file);
  }
  return web;
}

// Stride sample plus the pins a precise selection would have kept, and any
// colocated web test. Used whenever the precise set would be a guess.
function broaden({ cwd, paths, reason, extraRequired = [] }) {
  const existing = new Set(git(cwd, ['ls-files', '-z', '--', '.github/tests', 'test']).split('\0').filter(Boolean));
  const domain = domainTests(paths, existing);
  const changed = paths.filter((path) => TEST_FILE.test(path) && existing.has(path));
  const picked = selectFallback({ cwd, requiredTests: [...extraRequired, ...changed, ...domain.tests] });
  return {
    mode: 'fallback',
    reason,
    ...picked,
    node: domain.node,
    web: pinnedWeb(paths, webTests(cwd)),
    capped: 0,
    deferred: [],
  };
}

function withSmoke(sel, smoke) {
  const tests = [...smoke.tests];
  for (const file of sel.tests) if (!tests.includes(file)) tests.push(file);
  return tests;
}

export function plan({ cwd, paths, graph = null, base = null }) {
  const verdict = classifyPaths(paths);
  if (verdict.mode === 'docs') {
    if (paths.length === 0) return { ...verdict, tests: [], node: [], web: [], shards: [], capped: 0, deferred: [] };
    const sel = selectDocs({ cwd, paths });
    if (sel.tests.length === 0) {
      return { mode: 'fallback', reason: 'docs diff maps to no test', ...selectFallback({ cwd }), web: [], capped: 0 };
    }
    return { mode: 'related', reason: `${verdict.reason}: ${sel.tests.length} doc-reading test(s)`, ...sel, web: [], shards: [] };
  }
  if (verdict.mode === 'fallback') {
    const extra = paths.includes('package.json') ? [PACKAGE_FILES_TEST] : [];
    return broaden({ cwd, paths, reason: verdict.reason, extraRequired: extra });
  }
  const alive = paths.filter((path) => {
    try { return git(cwd, ['ls-files', '--', path]).trim() !== ''; }
    catch { return false; }
  });
  const sources = alive.filter((path) => isSource(path));
  if (sources.length === 0) {
    const sel = selectRelated({ cwd, paths });
    if (sel.tests.length === 0 && sel.node.length === 0 && sel.web.length === 0) {
      return broaden({ cwd, paths, reason: 'no test maps to the changed paths' });
    }
    return { ...verdict, ...sel, shards: [] };
  }
  const trust = assessGraph({ cwd, graph, base, sources });
  if (!trust.ok) return broaden({ cwd, paths, reason: trust.reason });
  const sel = selectRelated({ cwd, paths, graph });
  const nothing = sel.tests.length === 0 && sel.node.length === 0 && sel.web.length === 0;
  if (sel.orphans.length > 0) {
    const smoke = selectSmoke({ cwd });
    if (!smoke.ok) return broaden({ cwd, paths, reason: smoke.reason });
    if (nothing) {
      return {
        mode: 'smoke',
        reason: `changed source has no importers or colocated tests (smoke v${smoke.version})`,
        tests: smoke.tests,
        web: [],
        node: [],
        shards: [],
        capped: 0,
        deferred: sel.deferred,
      };
    }
    return {
      ...verdict,
      ...sel,
      tests: withSmoke(sel, smoke),
      reason: `${verdict.reason}; smoke v${smoke.version} for sources with no importers`,
      shards: [],
    };
  }
  if (nothing) return broaden({ cwd, paths, reason: 'no test maps to the changed paths' });
  return { ...verdict, ...sel, shards: [] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd();
  let result;
  try {
    const paths = changedPaths({ base: process.env.ASHLR_CI_BASE_SHA, head: process.env.ASHLR_CI_HEAD_SHA, cwd });
    let graph = null;
    if (process.env.CI_DEP_GRAPH) {
      try { graph = JSON.parse(readFileSync(process.env.CI_DEP_GRAPH, 'utf8')); }
      catch { graph = { schema: 'unparsable', files: {} }; }
    }
    result = { paths, ...plan({ cwd, paths, graph, base: process.env.ASHLR_CI_BASE_SHA ?? null }) };
  } catch (error) {
    // Selection errors fall back to the bounded broader set, never to no tests.
    console.error(`fast-gate selection failed (${error.message}); using fallback`);
    result = { paths: [], mode: 'fallback', reason: `selection error: ${error.message}`, ...selectFallback({ cwd }), web: [], capped: 0 };
  }
  const out = process.env.RUNNER_TEMP ?? '.';
  writeFileSync(resolve(out, 'fast-gate-plan.json'), JSON.stringify(result, null, 2));
  const webCount = result.web?.length ?? 0;
  const count = result.tests.length + result.node.length + webCount;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\ncount=${count}\n`);
  const note = `Fast gate selection: ${result.mode} (${result.reason}), ${result.tests.length} vitest + ${webCount} web + ${result.node.length} node test files` +
    (result.capped ? `, ${result.capped} more omitted by the cap` : '') +
    (result.deferred?.length ? `, ${result.deferred.length} slow or dist-bound files left to the master full suites` : '');
  console.log(note);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`);
}
