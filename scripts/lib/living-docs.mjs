/**
 * scripts/lib/living-docs.mjs: the engine behind scripts/docs-sync.mjs.
 *
 * "Living docs" are the committed files whose content is generated from the
 * repository itself — CLI help output, the docs page index, the source
 * directory map and the changelog's merged-PR block. Each one already has a
 * drift guard in test/ (doc-facts, cli-docs-drift, cli-reference-drift,
 * codemap-drift, docs-llms-txt); this module is the single place that
 * regenerates all of them so a merged PR's doc updates can be proposed as one
 * reviewable diff instead of five separate generator runs.
 *
 *   plan (default): compute every surface's expected bytes and report
 *     fresh/stale without writing; `ok` is false when anything is stale.
 *   write:          also write the stale files, so the diff can be proposed
 *     as a PR by whatever lane ran the sync.
 *
 * Everything is local: no network, no credentials, no pushes. The changelog
 * surface delegates to scripts/changelog-sync.mjs, whose snapshot contract
 * (scoped GitHub export or local `base..HEAD`) is documented in
 * scripts/CHANGELOG-SYNC.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureHelpOutput,
  firstDiff,
  renderCliDoc,
  SURFACES as CLI_DOC_SURFACES,
} from '../generate-cli-docs.mjs';
import { renderCliReference } from '../generate-cli-reference.js';
import { renderCodemap } from './codemap.mjs';
import { listDocsPages, renderLlmsTxt } from './docs-pages.mjs';

export const DOCS_SYNC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHANGELOG_SYNC_SCRIPT = join(DOCS_SYNC_ROOT, 'scripts', 'changelog-sync.mjs');
const CHANGELOG_TMP_PREFIX = 'phm-docs-sync-';
const FULL_SHA_RE = /^[a-f0-9]{40}$/;
const CHANGELOG_SYNC_TIMEOUT_MS = 60_000;

/**
 * The generated surfaces, in report order. `generate(ctx)` returns the exact
 * bytes the file should contain; ctx supplies the repo root, the current file
 * text and the shared/memoized helpers (help captures are run once per unique
 * argv across every surface that needs them).
 */
export const LIVING_DOC_SURFACES = Object.freeze([
  Object.freeze({
    name: 'cli',
    path: 'docs/cli.md',
    generates: 'phm --help and phm help --all captured into docs/cli.md',
    generate: ({ capture }) => renderCliDoc(
      CLI_DOC_SURFACES.map(({ title, args, note }) => ({ title, note, output: capture(args) })),
    ),
  }),
  Object.freeze({
    name: 'cli-reference',
    path: 'docs/CLI-REFERENCE.md',
    generates: 'the same two captures rendered as docs/CLI-REFERENCE.md',
    generate: ({ capture }) => renderCliReference(capture(['--help']), capture(['help', '--all'])),
  }),
  Object.freeze({
    name: 'llms',
    path: 'docs/llms.txt',
    generates: 'the generated page index block inside docs/llms.txt',
    generate: ({ root, current }) => renderLlmsTxt(current, listDocsPages(join(root, 'docs'))),
  }),
  Object.freeze({
    name: 'codemap',
    path: 'docs/CODEMAP.md',
    generates: 'the src/ and src/core/ directory inventory blocks in docs/CODEMAP.md',
    generate: ({ root, current }) => renderCodemap(current, { root }),
  }),
  Object.freeze({
    name: 'changelog',
    path: 'CHANGELOG.md',
    generates: 'the <!-- changelog-sync --> block in the Unreleased section, from merged-PR evidence',
    generate: ({ changelogSnapshotPath, changelogPath }) => {
      if (!existsSync(CHANGELOG_SYNC_SCRIPT)) {
        throw new SurfaceUnavailable('scripts/changelog-sync.mjs is not present in this checkout');
      }
      const snapshot = changelogSnapshotPath();
      const out = execFileSync(
        process.execPath,
        [CHANGELOG_SYNC_SCRIPT, 'update', '--snapshot', snapshot, '--changelog', changelogPath],
        { encoding: 'utf8', timeout: CHANGELOG_SYNC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return out;
    },
  }),
]);

export const LIVING_DOC_SURFACE_NAMES = Object.freeze(LIVING_DOC_SURFACES.map((s) => s.name));

/** A surface whose inputs are unavailable reports `skipped`, not `error`. */
export class SurfaceUnavailable extends Error {}

/** Default help capture: run the source CLI through tsx in a throwaway HOME, created on first use. */
function defaultCaptureFactory(root) {
  let home = null;
  const cache = new Map();
  return {
    capture(args) {
      const key = args.join('\x00');
      if (!cache.has(key)) {
        home ??= mkdtempSync(join(tmpdir(), 'phm-living-docs-'));
        cache.set(key, captureHelpOutput(args, { repoRoot: root, home }));
      }
      return cache.get(key);
    },
    cleanup() {
      if (home) rmSync(home, { recursive: true, force: true });
    },
  };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Resolve the changelog-sync snapshot to a file path. Explicit inputs win;
 * otherwise fall back to `<last release tag>..HEAD` — merged PRs since the
 * most recent tag, subjects only (PR titles need the scoped export, see
 * scripts/CHANGELOG-SYNC.md). Throws SurfaceUnavailable when nothing works.
 */
function changelogSnapshotResolver(root, changelog, tempHome) {
  return () => {
    if (changelog?.snapshotFile) {
      const file = resolve(changelog.snapshotFile);
      if (!existsSync(file)) throw new SurfaceUnavailable(`snapshot not found: ${changelog.snapshotFile}`);
      return file;
    }
    let data = changelog?.snapshotData ?? null;
    if (!data) {
      let base = changelog?.base ?? '';
      if (!base) {
        try {
          base = git(root, ['rev-list', '-1', git(root, ['describe', '--tags', '--abbrev=0'])]);
        } catch {
          throw new SurfaceUnavailable('no release tag to anchor --changelog-base; pass --changelog-snapshot or --changelog-base');
        }
      }
      if (!FULL_SHA_RE.test(base)) {
        throw new SurfaceUnavailable(`changelog base must be a full 40-character commit SHA, got ${JSON.stringify(base)}`);
      }
      data = { base, pullRequests: [] };
    }
    const file = join(tempHome, 'changelog-snapshot.json');
    writeFileSync(file, JSON.stringify(data));
    return file;
  };
}

/**
 * Run the sync. Options:
 *   root        repo checkout (default: this repo)
 *   write       write stale files (default: false — plan only)
 *   surfaces    subset of LIVING_DOC_SURFACE_NAMES (default: all)
 *   changelog   { snapshotFile | snapshotData | base } for the changelog surface
 *   deps        test seam: { capture(args)->string } replaces the real CLI capture
 */
export function syncDocs({
  root = DOCS_SYNC_ROOT,
  write = false,
  surfaces = LIVING_DOC_SURFACE_NAMES,
  changelog = undefined,
  deps = {},
} = {}) {
  const selected = new Set(surfaces);
  for (const name of selected) {
    if (!LIVING_DOC_SURFACE_NAMES.includes(name)) {
      throw new Error(`unknown surface ${JSON.stringify(name)}; known: ${LIVING_DOC_SURFACE_NAMES.join(', ')}`);
    }
  }
  const captureFactory = deps.capture
    ? { capture: deps.capture, cleanup: () => {} }
    : defaultCaptureFactory(root);
  const tempHome = mkdtempSync(join(tmpdir(), CHANGELOG_TMP_PREFIX));
  try {
    const changelogSnapshotPath = changelogSnapshotResolver(root, changelog ?? {}, tempHome);
    const ctx = {
      root,
      capture: captureFactory.capture,
      changelogSnapshotPath,
      changelogPath: join(root, 'CHANGELOG.md'),
    };
    const results = LIVING_DOC_SURFACES.filter((s) => selected.has(s.name)).map((surface) => {
      const file = join(root, surface.path);
      const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const base = { name: surface.name, path: surface.path, bytesBefore: before.length };
      let after;
      try {
        after = surface.generate({ ...ctx, current: before });
      } catch (error) {
        if (error instanceof SurfaceUnavailable) {
          return { ...base, status: 'skipped', detail: error.message };
        }
        const detail = error instanceof Error && typeof error.stderr === 'string' && error.stderr.trim()
          ? error.stderr.trim().split('\n')[0]
          : error instanceof Error ? error.message : String(error);
        return { ...base, status: 'error', detail };
      }
      if (after === before) return { ...base, status: 'fresh', bytesAfter: after.length };
      const diff = firstDiff(before, after);
      if (write) writeFileSync(file, after);
      return {
        ...base,
        status: write ? 'written' : 'stale',
        bytesAfter: after.length,
        firstDifference: diff ? { line: diff.line, actual: diff.actual, expected: diff.expected } : null,
      };
    });
    const changed = results.filter((r) => r.status === 'stale' || r.status === 'written');
    return {
      ok: results.every((r) => r.status === 'fresh' || r.status === 'written' || r.status === 'skipped'),
      mode: write ? 'write' : 'plan',
      root,
      surfaces: results,
      proposal: changed.length ? buildProposal(results, write) : null,
    };
  } finally {
    captureFactory.cleanup();
    rmSync(tempHome, { recursive: true, force: true });
  }
}

/** The deterministic PR proposal a publishing lane can open verbatim. */
export function buildProposal(results, applied) {
  const rows = results.map((r) => {
    const state = r.status === 'written' ? 'regenerated' : r.status;
    return `| \`${r.path}\` | ${r.name} | ${state}${r.detail ? ` — ${r.detail}` : ''} |`;
  });
  const body = [
    '## Living docs sync',
    '',
    `${applied ? 'Regenerated' : 'Would regenerate'} committed documentation that is generated from the repository itself:`,
    '',
    '| File | Surface | Status |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'Produced by `node --import tsx scripts/docs-sync.mjs` (see docs/LIVING-DOCS.md).',
    'Local generation only: this command never commits, pushes or opens pull',
    'requests — the publishing lane owns branch, commit and PR state.',
  ].join('\n');
  return { title: 'docs: refresh generated documentation (living-docs sync)', body };
}
