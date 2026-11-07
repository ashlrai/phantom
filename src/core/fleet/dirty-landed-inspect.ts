/**
 * core/fleet/dirty-landed-inspect.ts — per-PR "has this conflicting PR's work
 * already landed on its base?" inspection shared by `ashlr fleet dirty-landed`
 * and the recut loop. See src/cli/fleet-dirty-landed.ts for the class meanings.
 * Git objects and scratch refs live in a temporary bare repository; the host
 * repository and GitHub state are never written.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGitRunner } from '../verse/git-ops.js';

const SHA = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BYTES = 16 * 1024 * 1024;

/** The one obvious next step for a dirty PR. */
export type DirtyLandedClass = 'landed' | 'partly-landed' | 'needs-recut' | 'unknown';

export interface DirtyLandedPr {
  number: number;
  title: string;
  /** Pinned head from the `gh pr list` read; '' when the row did not carry one. */
  head: string;
  /** The PR's base branch (`master` for every fleet PR); '' when unreadable. */
  base: string;
  class: DirtyLandedClass;
  /** Paths the PR changes relative to its merge-base. */
  changedPaths: string[];
  /** Changed paths whose head content already matches the base tip. */
  landedPaths: string[];
  /** Changed paths whose head content still differs from the base tip. */
  remainingPaths: string[];
  /** Fixed machine token explaining an `unknown` class — never stderr text. */
  reason?: string;
  /** Bounded evidence for unusually wide zero-line diffs, when available. */
  diffAnomaly?: { kind: 'zero-line'; files: number; causes: ('mode-only' | 'generated-path' | 'other-zero-line')[] };
}

export interface DirtyRow {
  number: number;
  title: string;
  mergeable: string;
  mergeStateStatus: string;
  headSha: string;
  baseRef: string;
}

/** PURE: the class of one dirty PR from its changed paths vs the base tip. */
export function classifyDirtyLanded(changedPaths: readonly string[], stillDiffering: ReadonlySet<string>): DirtyLandedClass {
  const remaining = changedPaths.filter(path => stillDiffering.has(path));
  if (remaining.length === 0) return 'landed';
  return remaining.length === changedPaths.length ? 'needs-recut' : 'partly-landed';
}

async function git(dir: string, args: string[], maxStdoutBytes = GIT_MAX_BYTES) {
  return defaultGitRunner('git', args, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes });
}

/** NUL-delimited `git diff --name-only`; null when the diff cannot be read. */
async function diffPaths(dir: string, a: string, b: string): Promise<string[] | null> {
  const diff = await git(dir, ['diff', '--name-only', '-z', a, b]);
  if (diff.code !== 0 || diff.timedOut || diff.truncated) return null;
  return diff.stdout.split('\0').filter(path => path.length > 0);
}


/** Report only complete, non-binary zero-line diffs; generated paths are a naming heuristic. */
async function classifyWideDiff(dir: string, base: string, head: string, paths: string[]): Promise<DirtyLandedPr['diffAnomaly']> {
  if (paths.length < 1000) return undefined;
  const [stats, raw] = await Promise.all([
    git(dir, ['diff', '--no-renames', '--numstat', '-z', base, head]),
    git(dir, ['diff', '--no-renames', '--raw', '-z', base, head]),
  ]);
  if ([stats, raw].some(r => r.code !== 0 || r.timedOut || r.truncated)) return undefined;
  const entries = stats.stdout.split('\0').filter(Boolean);
  if (entries.length !== paths.length || entries.some(e => !/^0\t0\t/.test(e))) return undefined;
  const parts = raw.stdout.split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length !== paths.length * 2) return undefined;
  let modes = 0, generated = 0, other = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]$/.exec(parts[i]!);
    if (!match) return undefined;
    const path = parts[i + 1]!;
    if (match[1] !== match[2] && match[3] === match[4]) modes++;
    else if (/(?:^|\/)(?:generated|dist|build|vendor|node_modules)(?:\/|$)|(?:\.generated|\.min)\.[^/]+$/i.test(path)) generated++;
    else other++;
  }
  const causes: NonNullable<DirtyLandedPr['diffAnomaly']>['causes'] = [];
  if (modes) causes.push('mode-only');
  if (generated) causes.push('generated-path');
  if (other) causes.push('other-zero-line');
  return { kind: 'zero-line', files: paths.length, causes };
}

export function unknownDirtyLanded(row: DirtyRow, reason: string): DirtyLandedPr {
  return {
    number: row.number, title: row.title, head: row.headSha, base: row.baseRef,
    class: 'unknown', changedPaths: [], landedPaths: [], remainingPaths: [], reason,
  };
}

/**
 * Fetch this PR's base and head into the scratch repo, verify the head is the
 * one the list read pinned, and diff. Every failure lands in `unknown` with a
 * fixed reason; a moved head is never classified.
 */
export async function inspectDirtyLanded(dir: string, row: DirtyRow, remote: string): Promise<DirtyLandedPr> {
  if (!SHA.test(row.headSha)) return unknownDirtyLanded(row, 'row-unreadable');
  const baseRef = `refs/heads/${row.baseRef}`;
  if (!row.baseRef || (await git(dir, ['check-ref-format', baseRef])).code !== 0) {
    return unknownDirtyLanded(row, 'row-unreadable');
  }
  const fetch = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-write-fetch-head',
    remote, `+${baseRef}:refs/dirty/base`, `+refs/pull/${row.number}/head:refs/dirty/head`]);
  if (fetch.code !== 0 || fetch.timedOut || fetch.truncated) return unknownDirtyLanded(row, 'fetch-failed');
  const head = (await git(dir, ['rev-parse', 'refs/dirty/head'])).stdout.trim();
  const base = (await git(dir, ['rev-parse', 'refs/dirty/base'])).stdout.trim();
  if (head !== row.headSha || !SHA.test(base)) return unknownDirtyLanded(row, 'head-moved');
  const mergeBase = (await git(dir, ['merge-base', base, head])).stdout.trim();
  if (!SHA.test(mergeBase)) return unknownDirtyLanded(row, 'no-merge-base');
  const changedPaths = await diffPaths(dir, mergeBase, head);
  if (changedPaths === null) return unknownDirtyLanded(row, 'diff-failed');
  const differing = await diffPaths(dir, base, head);
  if (differing === null) return unknownDirtyLanded(row, 'diff-failed');
  const diffAnomaly = await classifyWideDiff(dir, mergeBase, head, changedPaths);
  const stillDiffering = new Set(differing);
  return {
    number: row.number, title: row.title, head: row.headSha, base: row.baseRef,
    class: classifyDirtyLanded(changedPaths, stillDiffering),
    ...(diffAnomaly ? { diffAnomaly } : {}),
    changedPaths,
    landedPaths: changedPaths.filter(path => !stillDiffering.has(path)),
    remainingPaths: changedPaths.filter(path => stillDiffering.has(path)),
  };
}

/** Run `fn` against a fresh temporary bare repo that is always removed afterwards. */
export async function withScratchRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-dirty-landed-'));
  try {
    const init = await git(dir, ['init', '--bare', '--quiet']);
    if (init.code !== 0) throw new Error('scratch-init-failed');
    return await fn(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
