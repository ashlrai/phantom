#!/usr/bin/env node
/**
 * scripts/docs-sync.mjs — one command keeps generated documentation honest.
 *
 * Several committed files are generated from repository state (package.json,
 * CHANGELOG.md headings, src/ layout, the CLI's own help and the site/ tree).
 * Each surface has its own generator and drift guard; this tool runs them all,
 * so a merged PR that bumps a version, adds a src/core directory or renames a
 * command never leaves a stale doc behind:
 *
 *   node scripts/docs-sync.mjs            regenerate every surface
 *   node scripts/docs-sync.mjs --check    report drift, write nothing, exit 1
 *   node scripts/docs-sync.mjs --local    skip the subprocess generators
 *   node scripts/docs-sync.mjs --json     machine-readable report
 *   node scripts/docs-sync.mjs --root dir operate on another checkout/fixture
 *
 * Local surfaces regenerate in-process:
 *
 *   markdown-freshness   fresh: blocks in README.md, CHANGELOG.md and the
 *                        Markdown under docs/ and examples/ (version badge,
 *                        install snippet, version table, example pin)
 *   site-freshness       fresh: blocks in site/*.html plus validation of every
 *                        ashlr/phm command line the pages show against the real
 *                        dispatch switch, verb tables and src/ flags
 *   codemap              docs/CODEMAP.md directory inventory blocks
 *   docs-llms            docs/llms.txt generated page index
 *   site-llms            site/llms.txt and site/llms-full.txt
 *
 * External surfaces delegate to their own generators, which rerun the CLI's
 * help output through tsx in a disposable HOME (slow; --local skips them):
 *
 *   cli-docs             docs/cli.md              (scripts/generate-cli-docs.mjs)
 *   cli-reference        docs/CLI-REFERENCE.md    (scripts/generate-cli-reference.ts)
 *
 * Deliberately out of scope: CHANGELOG.md release sections come from
 * release-please and the snapshot-scoped scripts/changelog-sync.mjs, and
 * site/sitemap.xml <lastmod> follows git commit dates (build-site-sitemap.mjs),
 * so neither is a deterministic source-of-truth surface.
 *
 * The module API reports a per-surface ledger; test/docs-sync.test.ts holds the
 * committed tree to `--check` for the local surfaces. No network, credentials
 * or runtime dependencies.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { synchronize as syncMarkdownFreshness } from './freshness/sync.mjs';
import { synchronize as syncSiteFreshness } from './site-freshness.mjs';
import { syncCodemap } from './codemap.mjs';
import { buildSiteLlms } from './generate-site-llms.mjs';
import { listDocsPages, renderLlmsTxt } from './lib/docs-pages.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const EXTERNAL_TIMEOUT_MS = 240_000;

/** docs/llms.txt's generated index block (same renderer as generate-docs-llms.mjs). */
function syncDocsLlms(root, { check }) {
  const rel = 'docs/llms.txt';
  const path = resolve(root, rel);
  const current = readFileSync(path, 'utf8');
  const source = readFileSync(join(root, 'docs', 'llms-source.txt'), 'utf8');
  const next = renderLlmsTxt(source, listDocsPages(join(root, 'docs')));
  if (next === current) return [];
  if (!check) writeFileSync(path, next);
  return [rel];
}

/** site/llms.txt and site/llms-full.txt from the site tree + package.json. */
function syncSiteLlms(root, { check }) {
  const changed = [];
  for (const [name, content] of Object.entries(buildSiteLlms(root))) {
    const rel = `site/${name}`;
    const path = resolve(root, rel);
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
    changed.push(rel);
    if (!check) writeFileSync(path, content);
  }
  return changed;
}

const LOCAL_SURFACES = [
  { id: 'markdown-freshness', run: (root, check) => syncMarkdownFreshness(root, { check }) },
  { id: 'site-freshness', run: (root, check) => syncSiteFreshness(root, { check }) },
  { id: 'codemap', run: (root, check) => syncCodemap(root, { check }) },
  { id: 'docs-llms', run: (root, check) => syncDocsLlms(root, { check }) },
  { id: 'site-llms', run: (root, check) => syncSiteLlms(root, { check }) },
];

function tsxLoader() {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  } catch {
    throw new Error('tsx is required to regenerate the CLI references; run `npm ci` first');
  }
}

const EXTERNAL_SURFACES = [
  {
    id: 'cli-docs',
    file: 'docs/cli.md',
    args: (root) => [join(root, 'scripts/generate-cli-docs.mjs')],
  },
  {
    id: 'cli-reference',
    file: 'docs/CLI-REFERENCE.md',
    args: (root) => ['--import', tsxLoader(), join(root, 'scripts/generate-cli-reference.ts')],
  },
];

const digest = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);

/** Run one delegated generator; returns the files it changed (or would change). */
function runExternal(root, check, spec, home) {
  const file = resolve(root, spec.file);
  const before = digest(file);
  const result = spawnSync(process.execPath, [...spec.args(root), ...(check ? ['--check'] : [])], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
    timeout: EXTERNAL_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (check) {
    // Generators exit 1 on drift; other failures carry stderr detail.
    if (result.status === 0) return [];
    if (result.status === 1) return [spec.file];
    throw new Error(`${spec.id} check failed:\n${String(result.stderr).slice(0, 2000)}`);
  }
  if (result.status !== 0) {
    throw new Error(`${spec.id} generator exited ${String(result.status)}:\n${String(result.stderr).slice(0, 2000)}`);
  }
  return digest(file) === before ? [] : [spec.file];
}

/**
 * Run every surface; returns { ok, surfaces: [{ id, status, files }] }.
 * status is 'drift' in check mode and 'updated' in sync mode when files differ.
 * `surfaces` restricts the run to the listed surface ids; unknown ids throw.
 */
export function docsSync(root = defaultRoot, { check = false, external = true, surfaces: only = null } = {}) {
  for (const id of only ?? []) {
    if (![...LOCAL_SURFACES, ...EXTERNAL_SURFACES].some((s) => s.id === id)) throw new Error(`Unknown docs-sync surface: ${id}`);
  }
  const wanted = (spec) => !only || only.includes(spec.id);
  const surfaces = [];
  const runSurface = (spec, run) => {
    try {
      const files = run(root, check);
      surfaces.push({ id: spec.id, status: files.length ? (check ? 'drift' : 'updated') : 'clean', files });
    } catch (error) {
      surfaces.push({ id: spec.id, status: 'error', files: [], detail: error instanceof Error ? error.message : String(error) });
    }
  };
  for (const spec of LOCAL_SURFACES) if (wanted(spec)) runSurface(spec, (r, c) => spec.run(r, c));
  const externalWanted = EXTERNAL_SURFACES.filter(wanted);
  if (external && externalWanted.length) {
    // Both delegated generators rerun the CLI's help; keep them off the real
    // ~/.ashlr even though the outer run only reads committed files.
    const home = mkdtempSync(join(tmpdir(), 'phm-docs-sync-'));
    try {
      for (const spec of externalWanted) runSurface(spec, (r, c) => runExternal(r, c, spec, home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  // ok means "nothing left to do": check mode needs every surface clean;
  // sync mode only needs no surface to have failed.
  return { ok: check ? surfaces.every((s) => s.status === 'clean') : surfaces.every((s) => s.status !== 'error'), check, surfaces };
}

export function main(args = process.argv.slice(2)) {
  let check = false;
  let external = true;
  let json = false;
  let root = defaultRoot;
  let only = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') check = true;
    else if (arg === '--local') external = false;
    else if (arg === '--json') json = true;
    else if (arg === '--root' && args[i + 1]) root = resolve(args[++i]);
    else if (arg === '--only' && args[i + 1]) only = args[++i].split(',');
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/docs-sync.mjs [--check] [--local] [--json] [--only id[,id…]] [--root directory]');
      return;
    } else throw new Error('Usage: node scripts/docs-sync.mjs [--check] [--local] [--json] [--only id[,id…]] [--root directory]');
  }
  const report = docsSync(root, { check, external, surfaces: only });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const surface of report.surfaces) {
      for (const file of surface.files) console.log(`${check ? 'drift' : 'updated'}: ${file} (${surface.id})`);
      if (surface.status === 'error') console.error(`${surface.id}: ${surface.detail}`);
    }
    console.log(`docs-sync: ${report.ok ? (check ? 'in sync' : 'synchronized') : check ? `${report.surfaces.filter((s) => s.status !== 'clean').length} surface(s) drifted` : 'completed with errors'}`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`docs-sync: ${error.message}`); process.exitCode = 1; }
}
