/**
 * Where generated adapters may be written, and the write/check routines.
 *
 * Allowlist, not denylist: output goes only to a subdirectory of the repo /
 * worktree root, or under `~/.ashlr-runs/staged/` for pin-stage. On top of
 * that, any path segment naming a live agent config location (`.codex`,
 * `.claude`, `.cursor`, `.mcp.json`, …) is refused even inside an allowed
 * root, because repo-local `.claude/` or `.cursor/mcp.json` are live configs
 * too. Symlinks are resolved on the nearest existing ancestor so a link
 * cannot redirect output into `~/.codex`.
 *
 * The generator never installs an adapter. Installing is a separate,
 * owner-run step after pin-stage.
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CapsBundle } from './generate.js';

/** Segments that are, or contain, live agent configuration. */
export const LIVE_CONFIG_SEGMENTS: ReadonlySet<string> = new Set([
  '.codex', '.claude', '.claude.json', '.cursor', '.gemini', '.devin', '.grok', '.copilot', '.qwen',
  '.vscode', '.mcp.json', '.config', '.ashlr', '.phantom', 'Library',
]);

export class CapsOutputError extends Error {}

function realish(path: string): string {
  // Resolve symlinks on the deepest existing ancestor, then re-append the rest.
  let probe = path;
  const rest: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    rest.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    probe = parent;
  }
  return join(realpathSync(probe), ...rest);
}

const inside = (root: string, path: string): string | null => {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
};

export interface OutputRoots {
  /** The repo or worktree root the registry lives in. */
  repoRoot: string;
  /** Home used for the pin-stage root; injectable for tests. */
  home?: string;
}

export function pinStageRoot(home: string = homedir()): string {
  return join(home, '.ashlr-runs', 'staged');
}

/** Resolve and approve an output directory, or throw `CapsOutputError`. */
export function assertSafeOutputDir(outDir: string, roots: OutputRoots): string {
  const target = realish(resolve(outDir));
  const home = realish(resolve(roots.home ?? homedir()));
  const allowed = [realish(resolve(roots.repoRoot)), realish(pinStageRoot(home))];
  const rel = allowed.map((root) => inside(root, target)).find((r) => r !== null);
  if (!rel) {
    throw new CapsOutputError('Output must be a subdirectory of the repo/worktree or of ~/.ashlr-runs/staged/. Generated adapters are never written into live agent config directories.');
  }
  const hit = rel.split(sep).find((part) => LIVE_CONFIG_SEGMENTS.has(part));
  if (hit) throw new CapsOutputError(`Output path contains "${hit}", a live agent config location. Write to a staging directory instead.`);
  // Absolute defense: never under a live dir in home, whatever the roots say.
  for (const seg of LIVE_CONFIG_SEGMENTS) {
    if (inside(join(home, seg), target) !== null || target === join(home, seg)) {
      throw new CapsOutputError(`Output resolves inside ~/${seg}, a live agent config location.`);
    }
  }
  return target;
}

interface PreviousManifest { artifacts?: Array<{ path?: unknown }> }

async function previousPaths(dir: string): Promise<string[]> {
  try {
    const prev = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as PreviousManifest;
    return (prev.artifacts ?? []).map((a) => a.path).filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

function artifactPath(dir: string, rel: string): string {
  const full = resolve(dir, rel);
  if (!inside(dir, full)) throw new CapsOutputError('Artifact path escapes the output directory.');
  return full;
}

export interface WriteResult { outDir: string; written: string[]; removed: string[] }

/**
 * Write a bundle. Files the previous manifest listed but this bundle does not
 * are removed; nothing else in the directory is touched.
 */
export async function writeCapsBundle(bundle: CapsBundle, outDir: string, roots: OutputRoots): Promise<WriteResult> {
  const dir = assertSafeOutputDir(outDir, roots);
  const current = new Set(bundle.artifacts.map((a) => a.path));
  const removed: string[] = [];
  for (const stale of await previousPaths(dir)) {
    if (current.has(stale)) continue;
    let full: string;
    try { full = artifactPath(dir, stale); } catch { continue; }
    await rm(full, { force: true });
    removed.push(stale);
  }
  const written: string[] = [];
  for (const a of bundle.artifacts) {
    const full = artifactPath(dir, a.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, a.content, 'utf8');
    written.push(a.path);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), bundle.manifestContent, 'utf8');
  return { outDir: dir, written: [...written, 'manifest.json'], removed: removed.sort() };
}

export interface DriftResult { ok: boolean; changed: string[]; missing: string[]; stale: string[] }

/** Compare a bundle with a directory without writing anything. */
export async function checkCapsBundle(bundle: CapsBundle, outDir: string): Promise<DriftResult> {
  const dir = resolve(outDir);
  const changed: string[] = [];
  const missing: string[] = [];
  const expected = [...bundle.artifacts.map((a) => ({ path: a.path, content: a.content })), { path: 'manifest.json', content: bundle.manifestContent }];
  for (const e of expected) {
    let actual: string;
    try { actual = await readFile(artifactPath(dir, e.path), 'utf8'); } catch { missing.push(e.path); continue; }
    if (actual !== e.content) changed.push(e.path);
  }
  const current = new Set(bundle.artifacts.map((a) => a.path));
  const stale = (await previousPaths(dir)).filter((p) => !current.has(p) && existsSync(join(dir, p)));
  return { ok: !changed.length && !missing.length && !stale.length, changed, missing, stale };
}

/** Nearest ancestor holding `.git` (a directory, or a worktree's `.git` file). */
export function findRepoRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
