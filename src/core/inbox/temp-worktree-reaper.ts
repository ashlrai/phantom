/**
 * Crash-leftover reaper for the throwaway worktrees inbox/merge.ts creates
 * under `~/.ashlr/tmp` (`vwt-<hex>` verify, `mwt-<hex>` staging build,
 * `mergewt-<hex>` local merge).
 *
 * Those worktrees are removed in a `finally`, which never runs when the daemon
 * is SIGKILLed / OOM-killed / self-SIGTERMed mid-run. The worktree directory,
 * its registration in the target repo (often a fleet mirror) and, for verify,
 * its `ashlr/verify/<hex>` scratch branch then leak forever — and a leaked
 * `mergewt-` keeps the default branch checked out, so every later local merge
 * fails at `worktree add`.
 *
 * Every such worktree now carries an owner marker `<dir>.owner` (pid + a
 * verified process-start reference). Before creating a new one in a repo the
 * caller runs {@link reapLeakedTempWorktrees} under the same lock it holds for
 * the creation. Fail-closed rules:
 *   - only registrations whose path is DIRECTLY under the ashlr tmp dir and
 *     whose basename matches ^(vwt|mwt|mergewt)-[0-9a-f]+$ are candidates;
 *   - a valid marker reaps only when the owner is provably gone (ESRCH) or its
 *     pid was reused (verified start reference differs); anything uncertain
 *     keeps the worktree;
 *   - a missing / unreadable marker reaps only after a conservative age
 *     (marker or directory mtime), never when no timestamp is available;
 *   - only a `vwt-` entry's branch matching refs/heads/ashlr/verify/<hex> is
 *     deleted. `mwt-` is detached and `mergewt-` holds the default branch:
 *     their branches are never touched.
 *
 * Daemon start additionally runs {@link sweepLeakedTempWorktreesAtStart}: it
 * derives each leftover's owning repo from the leftover's own `.git` pointer
 * and runs the same reaper there under that repo's mirror lease, so a crashed
 * daemon's leftovers do not wait for the next merge in that repo.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isMirrorPath, mirrorLeaseKey } from '../fleet/mirrors.js';
import { withRepoLease } from '../sandbox/execution-leases.js';
import {
  verifiedProcessStartIdentity,
  type ProcessStartIdentitySource,
  type VerifiedProcessStartIdentity,
} from '../fleet/local-store-lock.js';

const GIT_TIMEOUT = 30_000;
const TEMP_WORKTREE_NAME = /^(vwt|mwt|mergewt)-[0-9a-f]+$/;
const VERIFY_BRANCH_REF = /^refs\/heads\/(ashlr\/verify\/[0-9a-f]+)$/;
const START_SOURCES: readonly ProcessStartIdentitySource[] = [
  'self-clock-epoch-second', 'ps-lstart', 'linux-proc-start-ticks', 'windows-start-ticks',
];
const MAX_MARKER_BYTES = 4_096;

/** Markerless / unreadable-marker leftovers are reaped only once older than this. */
export const MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS = 6 * 60 * 60 * 1_000;

/** The directory inbox/merge.ts creates its throwaway worktrees in. */
export function ashlrTmpDir(): string {
  return join(homedir(), '.ashlr', 'tmp');
}

/** Same hardening as merge.ts gitRun: no hooks, no fsmonitor, no shell. */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd,
      timeout: GIT_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function markerPathFor(dir: string): string {
  return `${dir}.owner`;
}

let ownStart: VerifiedProcessStartIdentity | null | undefined;
function ownStartIdentity(): VerifiedProcessStartIdentity | null {
  if (ownStart === undefined) ownStart = verifiedProcessStartIdentity(process.pid) ?? null;
  return ownStart;
}

/**
 * Write the owner marker for a temp worktree about to be created at `dir`.
 * Throws on failure so the caller refuses to create an unmarked worktree.
 */
export function writeTempWorktreeOwner(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const start = ownStartIdentity();
  const body = {
    schemaVersion: 1,
    pid: process.pid,
    ...(start ? { startRef: start.ref, startSource: start.source } : {}),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(markerPathFor(dir), `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
}

/** Drop the owner marker once the worktree directory is gone (kept otherwise). */
export function releaseTempWorktreeOwner(dir: string): void {
  try {
    lstatSync(dir);
    return; // directory still there: keep the marker so a later reaper can judge it
  } catch { /* gone */ }
  try {
    unlinkSync(markerPathFor(dir));
  } catch { /* best effort */ }
}

type OwnerState = 'alive' | 'dead' | 'unknown';

function readOwnerState(markerPath: string): OwnerState {
  try {
    const st = lstatSync(markerPath);
    if (!st.isFile() || st.size < 1 || st.size > MAX_MARKER_BYTES) return 'unknown';
    const owner = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    const pid = owner['pid'];
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return 'unknown';
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
    }
    const startRef = owner['startRef'];
    const startSource = owner['startSource'];
    if (typeof startRef !== 'string' || !/^[a-f0-9]{64}$/.test(startRef) ||
      !START_SOURCES.includes(startSource as ProcessStartIdentitySource)) {
      return 'alive'; // live pid without a usable start reference: cannot prove reuse
    }
    const requiredSource = startSource as ProcessStartIdentitySource;
    const observe = (): string | undefined =>
      pid === process.pid && ownStartIdentity()?.source === requiredSource
        ? ownStartIdentity()?.ref
        : verifiedProcessStartIdentity(pid, { requiredSource })?.ref;
    const observed = observe();
    if (observed && observed !== startRef) {
      const confirmed = observe();
      if (confirmed && confirmed !== startRef) return 'dead'; // pid reused by another process
    }
    return 'alive';
  } catch {
    return 'unknown';
  }
}

function newestMtimeMs(paths: string[]): number | null {
  let newest: number | null = null;
  for (const p of paths) {
    try {
      const m = lstatSync(p).mtimeMs;
      if (newest === null || m > newest) newest = m;
    } catch { /* absent */ }
  }
  return newest;
}

interface PorcelainEntry {
  path: string;
  branch: string | null;
}

function parsePorcelain(out: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let current: PorcelainEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line.trim() === '') {
      current = null;
    }
  }
  return entries;
}

function tmpRoots(): Set<string> {
  const roots = new Set<string>([resolve(ashlrTmpDir())]);
  try {
    roots.add(realpathSync(ashlrTmpDir()));
  } catch { /* not created yet */ }
  return roots;
}

export interface ReapTempWorktreesResult {
  reaped: string[];
  kept: string[];
  failed: string[];
  branchesDeleted: string[];
}

export interface ReapTempWorktreesOptions {
  now?: number;
  markerlessMaxAgeMs?: number;
}

/**
 * Reap crash-leftover ashlr temp worktrees registered in `repo`. Never throws.
 * Callers run it under the same lock (mirror lease / mutation fence) that
 * guards their own `worktree add` in `repo`.
 */
export function reapLeakedTempWorktrees(
  repo: string,
  options: ReapTempWorktreesOptions = {},
): ReapTempWorktreesResult {
  const result: ReapTempWorktreesResult = { reaped: [], kept: [], failed: [], branchesDeleted: [] };
  try {
    const porcelain = gitTry(repo, ['worktree', 'list', '--porcelain']);
    if (!porcelain) return result;
    const now = options.now ?? Date.now();
    const maxAge = options.markerlessMaxAgeMs ?? MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS;
    const roots = tmpRoots();
    const tmpDir = ashlrTmpDir();
    let mutated = false;
    for (const entry of parsePorcelain(porcelain)) {
      const name = basename(entry.path);
      if (!TEMP_WORKTREE_NAME.test(name) || !roots.has(dirname(resolve(entry.path)))) continue;
      const markerPath = markerPathFor(join(tmpDir, name));
      let reap: boolean;
      const state = readOwnerState(markerPath);
      if (state === 'dead') {
        reap = true;
      } else if (state === 'alive') {
        reap = false;
      } else {
        const mtime = newestMtimeMs([markerPath, entry.path]);
        reap = mtime !== null && now - mtime > maxAge;
      }
      if (!reap) {
        result.kept.push(entry.path);
        continue;
      }
      mutated = true;
      gitTry(repo, ['worktree', 'remove', '--force', '--force', entry.path]);
      let dirGone = false;
      try {
        lstatSync(entry.path);
      } catch {
        dirGone = true;
      }
      if (!dirGone) {
        result.failed.push(entry.path);
        continue;
      }
      result.reaped.push(entry.path);
      try {
        unlinkSync(markerPath);
      } catch { /* absent */ }
      const branch = name.startsWith('vwt-') && entry.branch ? VERIFY_BRANCH_REF.exec(entry.branch)?.[1] : undefined;
      if (branch) {
        gitTry(repo, ['worktree', 'prune']);
        if (gitTry(repo, ['branch', '-D', branch]) !== null) result.branchesDeleted.push(branch);
      }
    }
    if (mutated) gitTry(repo, ['worktree', 'prune']);
  } catch { /* never throws */ }
  return result;
}

/** How long the start-time sweep waits for a busy mirror lease before skipping that repo. */
export const START_SWEEP_MIRROR_LEASE_WAIT_MS = 2_000;
const MAX_GIT_POINTER_BYTES = 4_096;

/**
 * The repo a temp worktree directory belongs to, read from its `.git` pointer
 * (`gitdir: <common-dir>/worktrees/<name>`). Null for anything that is not a
 * plain linked-worktree pointer named after the directory.
 */
export function tempWorktreeOwningRepo(dir: string): string | null {
  try {
    const name = basename(dir);
    if (!TEMP_WORKTREE_NAME.test(name)) return null;
    const pointer = join(dir, '.git');
    const st = lstatSync(pointer);
    if (!st.isFile() || st.size > MAX_GIT_POINTER_BYTES) return null;
    const adminDir = /^gitdir: (.+)$/m.exec(readFileSync(pointer, 'utf8'))?.[1]?.trim();
    if (!adminDir || !isAbsolute(adminDir)) return null;
    // git suffixes the admin dir with a number when the name is already taken.
    const adminName = basename(adminDir);
    if (adminName !== name && !(adminName.startsWith(name) && /^\d+$/.test(adminName.slice(name.length)))) {
      return null;
    }
    if (basename(dirname(adminDir)) !== 'worktrees') return null;
    const commonDir = dirname(dirname(adminDir));
    const repo = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
    return lstatSync(repo).isDirectory() ? repo : null;
  } catch {
    return null;
  }
}

/** Every repo owning at least one `vwt-` / `mwt-` / `mergewt-` directory in the ashlr tmp dir. */
export function leakedTempWorktreeRepos(): string[] {
  let names: string[];
  try {
    names = readdirSync(ashlrTmpDir());
  } catch {
    return [];
  }
  const repos = new Set<string>();
  for (const name of names.sort()) {
    if (!TEMP_WORKTREE_NAME.test(name)) continue;
    const repo = tempWorktreeOwningRepo(join(ashlrTmpDir(), name));
    if (repo) repos.add(repo);
  }
  return [...repos];
}

/** `fn` under the repo's mirror lease when it is a fleet mirror, directly otherwise; null when busy. */
async function underStartSweepLease<T>(repo: string, fn: () => T): Promise<{ value: T } | null> {
  let mirror = false;
  try {
    mirror = isMirrorPath(repo);
  } catch {
    mirror = false;
  }
  if (!mirror) return { value: fn() };
  const leased = await withRepoLease(mirrorLeaseKey(repo), () => fn(), { waitMs: START_SWEEP_MIRROR_LEASE_WAIT_MS });
  return leased.ok ? { value: leased.value } : null;
}

export interface StartTempWorktreeSweepResult {
  /** Repos the leftovers pointed at. */
  repos: number;
  reaped: number;
  kept: number;
  failed: number;
  branchesDeleted: number;
  /** Repos skipped because their mirror lease stayed busy or the reaper threw. */
  skippedRepos: number;
}

export interface StartTempWorktreeSweepOptions extends ReapTempWorktreesOptions {
  /** Test seam; production uses {@link reapLeakedTempWorktrees}. */
  reap?: (repo: string, options: ReapTempWorktreesOptions) => ReapTempWorktreesResult;
}

/**
 * Daemon-start sweep: reap leaked temp worktrees in every repo that still has
 * one in the ashlr tmp dir, under the same mirror lease inbox/merge.ts holds
 * for its verify `worktree add`. Only the reaper's fail-closed owner rules
 * decide what is removed, so another live process's worktree is always kept.
 * The reaper already runs `git worktree prune` in a repo it mutated. Never throws.
 */
export async function sweepLeakedTempWorktreesAtStart(
  options: StartTempWorktreeSweepOptions = {},
): Promise<StartTempWorktreeSweepResult> {
  const total: StartTempWorktreeSweepResult = {
    repos: 0, reaped: 0, kept: 0, failed: 0, branchesDeleted: 0, skippedRepos: 0,
  };
  const { reap = reapLeakedTempWorktrees, ...reapOptions } = options;
  let repos: string[];
  try {
    repos = leakedTempWorktreeRepos();
  } catch {
    return total;
  }
  total.repos = repos.length;
  for (const repo of repos) {
    try {
      const leased = await underStartSweepLease(repo, () => reap(repo, reapOptions));
      if (!leased) {
        total.skippedRepos += 1;
        continue;
      }
      total.reaped += leased.value.reaped.length;
      total.kept += leased.value.kept.length;
      total.failed += leased.value.failed.length;
      total.branchesDeleted += leased.value.branchesDeleted.length;
    } catch {
      total.skippedRepos += 1;
    }
  }
  return total;
}
