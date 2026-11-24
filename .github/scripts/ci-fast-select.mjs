#!/usr/bin/env node
/* global process, console */
// Fast-gate test selection (RQ-CI-FASTGATE-1). Pure policy plus a thin git CLI.
//
// The fast gate must finish in about a minute, so it runs a bounded set of
// tests instead of `vitest related`: a transitive related run from one core
// file (src/core/authority/protected-paths.ts) was still running after eight
// minutes locally. Selection is: changed test files, name-matched tests, and
// tests that import a changed module directly, capped at MAX_RELATED_TESTS.
// The exhaustive import graph stays on the master schedule.
//
// Modes: docs (doc-reading tests, see selectDocs), related (selected tests),
// fallback (a bounded broader set, used when a global input changed or
// selection failed). Nothing ever skips tests silently: every uncertain input
// resolves to fallback.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedPaths } from './ci-changed-paths.mjs';
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

// `cap` defaults to the fast-gate budget. Preflight passes a larger cap; the
// fast gate keeps MAX_RELATED_TESTS. Changed tests and named Tier-1 tests are
// pinned and are never cut below that count. When `graph` covers every changed
// source, its direct importers are used; otherwise git grep is.
export function selectRelated({ cwd, paths, cap = MAX_RELATED_TESTS, graph = null }) {
  const testFiles = new Set(git(cwd, ['ls-files', '-z', '--', 'test']).split('\0').filter((f) => TEST_FILE.test(f)));
  const existing = new Set(git(cwd, ['ls-files', '-z', '--', '.github/tests', 'test']).split('\0'));
  const alive = paths.filter((p) => existing.has(p) || git(cwd, ['ls-files', '--', p]).trim() !== '');
  const ranked = [];
  const deferred = [];
  const add = (f, derived = false) => {
    if (!testFiles.has(f) || ranked.includes(f) || deferred.includes(f)) return;
    if (needsDist(cwd, f) || (derived && SLOW.has(f) && !TIER1_TESTS.includes(f))) { deferred.push(f); return; }
    ranked.push(f);
  };
  for (const p of alive) if (TEST_FILE.test(p)) add(p); // changed tests first
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
  const pinned = ranked.length;
  const sources = alive.filter((p) => SOURCE_FILE.test(p) && !TEST_FILE.test(p));
  for (const p of sources) {
    const stem = p.replace(/\.(?:ts|tsx|mjs|js)$/, '').split('/').pop();
    for (const f of testFiles) if (f.endsWith(`/${stem}.test.ts`)) add(f, true); // name-matched
  }
  const importers = new Set();
  const covered = graph?.files && sources.every((p) => graph.files[p]);
  if (covered) {
    for (const [file, node] of Object.entries(graph.files)) {
      if (testFiles.has(file) && node.imports.some((imported) => sources.includes(imported))) importers.add(file);
    }
  } else {
    for (const p of sources) for (const f of importersOf(cwd, p, testFiles)) importers.add(f);
  }
  for (const f of [...importers].sort()) add(f, true);
  const limit = Math.max(cap, pinned);
  return { tests: ranked.slice(0, limit), capped: Math.max(0, ranked.length - limit), deferred, node: domain.node };
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

export function plan({ cwd, paths, graph = null }) {
  const verdict = classifyPaths(paths);
  if (verdict.mode === 'docs') {
    if (paths.length === 0) return { ...verdict, tests: [], node: [], shards: [], capped: 0, deferred: [] };
    const sel = selectDocs({ cwd, paths });
    if (sel.tests.length === 0) {
      return { mode: 'fallback', reason: 'docs diff maps to no test', ...selectFallback({ cwd }), capped: 0 };
    }
    return { mode: 'related', reason: `${verdict.reason}: ${sel.tests.length} doc-reading test(s)`, ...sel, shards: [] };
  }
  if (verdict.mode === 'fallback') {
    const requiredTests = paths.includes('package.json') ? [PACKAGE_FILES_TEST] : [];
    return { ...verdict, ...selectFallback({ cwd, requiredTests }), capped: 0 };
  }
  const sel = selectRelated({ cwd, paths, graph });
  if (sel.tests.length === 0 && sel.node.length === 0) {
    // Code changed but nothing maps to a test: never skip, run the bounded set.
    return { mode: 'fallback', reason: 'no test maps to the changed paths', ...selectFallback({ cwd }), capped: 0 };
  }
  return { ...verdict, ...sel, shards: [] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd();
  let result;
  try {
    const paths = changedPaths({ base: process.env.ASHLR_CI_BASE_SHA, head: process.env.ASHLR_CI_HEAD_SHA, cwd });
    let graph = null;
    if (process.env.CI_DEP_GRAPH) {
      try { graph = JSON.parse(readFileSync(process.env.CI_DEP_GRAPH, 'utf8')); } catch { graph = null; }
    }
    result = { paths, ...plan({ cwd, paths, graph }) };
  } catch (error) {
    // Selection errors fall back to the bounded broader set, never to no tests.
    console.error(`fast-gate selection failed (${error.message}); using fallback`);
    result = { paths: [], mode: 'fallback', reason: `selection error: ${error.message}`, ...selectFallback({ cwd }), capped: 0 };
  }
  const out = process.env.RUNNER_TEMP ?? '.';
  writeFileSync(resolve(out, 'fast-gate-plan.json'), JSON.stringify(result, null, 2));
  const count = result.tests.length + result.node.length;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\ncount=${count}\n`);
  const note = `Fast gate selection: ${result.mode} (${result.reason}), ${result.tests.length} vitest + ${result.node.length} node test files` +
    (result.capped ? `, ${result.capped} more omitted by the cap` : '') +
    (result.deferred?.length ? `, ${result.deferred.length} slow or dist-bound files left to the master full suites` : '');
  console.log(note);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`);
}
