#!/usr/bin/env node
/* global process, console */
// Per-PR test selection (RQ-CI-DAILYFULL-1). A pull request or merge-queue
// commit runs the Tier-1 set plus every backend test that can reach a changed
// file, on Ubuntu only. Anything this selector cannot reason about (package
// manifests, test runner config, test setup) falls back to the whole backend
// suite, sharded. The full ci.yml, with Mac and Windows, runs daily on master
// and on release candidates, so selection only needs to be sound for the
// common case, never a substitute for that run.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeModule } from './ci-impact-shadow.mjs';
import { builtDistModules, requiresBuiltDist, selectDocsMarkdownTests } from './select-docs-markdown-tests.mjs';

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const BACKEND_TEST = /^test\/.+\.test\.(?:ts|tsx|mts)$/;
const SHA = /^[0-9a-f]{40}$/;
// Mirrors ci.yml: the ledger suite needs a fresh HOME and one worker, so only
// the daily run executes it.
const DAILY_ONLY_TESTS = Object.freeze(['test/m342.dispatch-production-ledger.test.ts']);

/**
 * Tier-1: the authority suites and the never-weaken invariant suites
 * (`npm run test:invariants`), plus the suites pinning this workflow. They run
 * on every PR whatever the diff touches.
 */
export const TIER1_TEST_PATTERNS = Object.freeze([
  /^test\/authority-[^/]+\.test\.ts$/,
  /^test\/h\d+[^/]*\.test\.ts$/,
  /^test\/protected-paths-[^/]+\.test\.ts$/,
  /^test\/m30\.ci\.test\.ts$/,
  /^test\/m481\.ci-action-pins\.test\.ts$/,
]);

/** Inputs that reach every test without an import edge: run the whole suite. */
export function globalInputReason(path) {
  if (/^package(?:-lock)?\.json$/.test(path)) return 'package manifest';
  if (/^tsconfig[^/]*\.json$/.test(path)) return 'tsconfig';
  if (/^vitest\.config[^/]*$/.test(path) || /^vite\.config[^/]*$/.test(path)) return 'vitest config';
  if (path.startsWith('test/setup/') || path.startsWith('test/config/')) return 'test setup';
  if (/^scripts\/(?:test-ci[^/]*|vitest-progress-reporter)\.mjs$/.test(path)) return 'test runner';
  return null;
}

const isTier1 = (path) => TIER1_TEST_PATTERNS.some((pattern) => pattern.test(path));

// Every spelling a relative specifier may resolve to; nonexistent names are
// kept so a deleted module still selects its former importers.
function candidates(from, spec) {
  if (!spec.startsWith('.')) return [];
  const raw = posix.normalize(posix.join(posix.dirname(from), spec));
  if (raw.startsWith('../')) return [];
  const names = [raw];
  if (/\.[cm]?js$/.test(raw)) names.push(raw.replace(/\.js$/, '.ts'), raw.replace(/\.js$/, '.tsx'), raw.replace(/\.mjs$/, '.mts'));
  if (!posix.extname(raw)) for (const ext of ['.ts', '.tsx', '.js', '.mjs']) names.push(raw + ext, `${raw}/index${ext}`);
  return names;
}

// Tests reference data files by path; join('a', 'b') should match 'a/b'.
const flatten = (text) => text.replace(/['"`]\s*,\s*['"`]/g, '/');

function mentionKeys(path) {
  const keys = [path];
  const dir = posix.dirname(path);
  if (dir.split('/').length >= 2) keys.push(`${dir}/`);
  return keys;
}

/**
 * Pure selection. `files` is the tracked tree (head), `changed` the diff paths
 * (deleted ones included), `read(path)` returns UTF-8 text of a head file.
 */
export function selectTests({ changed, files, read, distModules = new Set(['require-built-dist']), markdownTests = () => selectDocsMarkdownTests().selected }) {
  const tracked = new Set(files);
  const allTests = files.filter((path) => BACKEND_TEST.test(path) && !path.startsWith('src/web-ui/')).sort();
  const tier1 = allTests.filter(isTier1);
  const web = changed.some((path) => path.startsWith('src/web-ui/') || /^vitest\.config\.web\./.test(path) || path === 'tsconfig.web.json');
  const docs = changed.some((path) => path.endsWith('.md') || path.startsWith('docs/'));
  const nodeTests = [...new Set(changed.flatMap((path) => {
    if (/^\.github\/tests\/[^/]+\.test\.mjs$/.test(path)) return [path];
    const match = /^\.github\/scripts\/([^/]+)\.mjs$/.exec(path);
    return match ? [`.github/tests/${match[1]}.test.mjs`] : [];
  }))].filter((path) => tracked.has(path)).sort();
  const base = { web, docs, nodeTests, changed: changed.length, totalTests: allTests.length };

  const global = changed.map(globalInputReason).find(Boolean);
  if (global) {
    return { ...base, mode: 'full', reason: `global input changed (${global})`, tests: allTests.filter((path) => !DAILY_ONLY_TESTS.includes(path)), tier1, buildNeeded: true, web: true };
  }

  // Reverse import graph over every tracked module, plus textual mentions of
  // non-module files (fixtures, Markdown, JSON) that tests read by path.
  const codeFiles = files.filter((path) => CODE.test(path) && !path.startsWith('src/web-ui/'));
  const importers = new Map();
  const texts = new Map();
  for (const path of codeFiles) {
    const text = read(path) ?? '';
    texts.set(path, text);
    if (!/^(?:src|test|scripts|bin)\//.test(path)) continue;
    for (const spec of analyzeModule(path, text).imports) {
      for (const name of candidates(path, spec)) {
        if (!importers.has(name)) importers.set(name, new Set());
        importers.get(name).add(path);
      }
    }
  }
  const seeds = new Set(changed);
  const mentioned = changed.filter((path) => !CODE.test(path));
  if (mentioned.length > 0) {
    const keys = mentioned.flatMap(mentionKeys);
    for (const [path, text] of texts) {
      const flat = flatten(text);
      if (keys.some((key) => flat.includes(key))) seeds.add(path);
    }
  }
  const reached = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const path = queue.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    for (const importer of importers.get(path) ?? []) queue.push(importer);
  }
  const affected = allTests.filter((path) => reached.has(path));
  // Markdown edits also run the Markdown-reading suites the docs lane selects.
  const markdown = docs ? markdownTests() : [];
  const selected = [...new Set([...tier1, ...affected, ...markdown])]
    .filter((path) => tracked.has(path) && !DAILY_ONLY_TESTS.includes(path)).sort();
  const buildNeeded = selected.some((path) => requiresBuiltDist(texts.get(path) ?? '', distModules));
  return { ...base, mode: 'selected', reason: 'import graph and Tier-1', tests: selected, tier1, affected: affected.length, buildNeeded };
}

/** Deterministic round-robin so a shard never depends on another's result. */
export function partition(list, index, total) {
  return list.filter((_, position) => position % total === index - 1);
}

export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? '');
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`invalid shard ${JSON.stringify(value)}`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

/** The commands one shard runs, in order. Pure so the workflow stays thin. */
export function shardCommands(plan, { index, total }) {
  const commands = [];
  const mine = partition(plan.tests, index, total);
  if (plan.buildNeeded && mine.length > 0) commands.push(['npm', 'run', 'build']);
  if (mine.length > 0) commands.push(['npm', 'run', 'test:ci', '--', ...mine]);
  // Singleton work runs once, on shard 1.
  if (index === 1) {
    if (plan.web) commands.push(['npm', 'run', 'typecheck:web'], ['npm', 'run', 'test:web']);
    if (plan.docs) commands.push(['npm', 'run', 'check:docs']);
    if (plan.nodeTests.length > 0) commands.push(['node', '--test', ...plan.nodeTests]);
  }
  return commands;
}

function gitText(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function changedPaths(base, head) {
  const mergeBase = gitText(['merge-base', base, head]).trim();
  return gitText(['diff', '--name-only', '--no-renames', '-z', mergeBase, head, '--']).split('\0').filter(Boolean);
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const shardIndex = argv.indexOf('--shard');
  const shard = parseShard(shardIndex === -1 ? undefined : argv[shardIndex + 1]);
  const { ASHLR_CI_BASE_SHA: base, ASHLR_CI_HEAD_SHA: head } = process.env;
  // Unknown Git state selects nothing safely: fail instead of guessing.
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) throw new Error('ASHLR_CI_BASE_SHA and ASHLR_CI_HEAD_SHA must be 40-hex commits');
  const root = process.cwd();
  const files = gitText(['ls-files', '-z']).split('\0').filter(Boolean);
  const read = (path) => { try { return readFileSync(resolve(root, path), 'utf8'); } catch { return null; } };
  const plan = selectTests({ changed: changedPaths(base, head), files, read, distModules: builtDistModules(root) });
  const commands = shardCommands(plan, shard);
  const summary = `Affected tests ${shard.index}/${shard.total}: ${plan.mode} (${plan.reason}); ${plan.changed} changed path(s); ` +
    `${plan.tests.length}/${plan.totalTests} tests selected (${plan.tier1.length} Tier-1); ${partition(plan.tests, shard.index, shard.total).length} on this shard` +
    `${plan.web ? '; web' : ''}${plan.docs ? '; docs' : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const command of commands) {
    console.log(`$ ${command.join(' ')}`);
    if (dryRun) continue;
    const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`${command.slice(0, 3).join(' ')} failed (${result.status ?? result.signal})`);
      process.exitCode = result.status || 1;
      return;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`Affected-test selection failed: ${error.message}`); process.exitCode = 1; }
}
