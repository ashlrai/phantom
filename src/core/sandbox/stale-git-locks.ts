/**
 * Read-only detection of git lock files left behind by a git process that was
 * killed mid-update (an agent SIGKILLed during `branch -D`, `update-ref`,
 * `worktree add`, a commit).
 *
 * Git writes `<file>.lock`, then renames it over `<file>`. A kill between the
 * two leaves the lock, and every later ref update in that repository fails
 * with "Unable to create '…/packed-refs.lock': File exists" until someone
 * removes it. Git records no owner in these files (no pid, no host), so there
 * is no proof that the writer is gone; a lock on a shared or network mount may
 * belong to a live process on another machine. These helpers therefore only
 * REPORT locks older than a conservative age and never delete anything: the
 * owner, who can see whether a git process is still running, decides.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/** Locks younger than this are treated as in use. Real ref updates take milliseconds. */
export const STALE_GIT_LOCK_MIN_AGE_MS = 10 * 60 * 1_000;

/** Upper bound on directory entries visited under `refs/` per repository. */
const MAX_REF_ENTRIES = 50_000;
const MAX_REF_DEPTH = 32;
const GIT_TIMEOUT_MS = 10_000;

/** Lock files at the top of the common git dir that block ref, config or index updates. */
const TOP_LEVEL_LOCKS = ['packed-refs.lock', 'HEAD.lock', 'config.lock', 'shallow.lock', 'index.lock'];
/** Lock files inside each linked worktree's admin dir (`worktrees/<name>/`). */
const WORKTREE_LOCKS = ['HEAD.lock', 'index.lock'];

export interface StaleGitLock {
  /** Absolute path of the lock file. */
  path: string;
  /** The repository (as given) whose common git dir holds it. */
  repo: string;
  /** Age from the lock's mtime, in milliseconds. */
  ageMs: number;
}

export interface FindStaleGitLocksOptions {
  minAgeMs?: number;
  /** Test seam. */
  now?: number;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Absolute, canonical common git dir of `repo`, or null when it is not a git repository. */
export function gitCommonDir(repo: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
    return out ? realpathSync.native(out) : null;
  } catch {
    return null;
  }
}

/**
 * Lock files under the common git dir `commonDir` older than `minAgeMs`.
 * Never follows symlinks and never writes.
 */
export function findStaleGitLocksInCommonDir(
  commonDir: string,
  repo: string,
  opts: FindStaleGitLocksOptions = {},
): StaleGitLock[] {
  const minAgeMs = opts.minAgeMs ?? STALE_GIT_LOCK_MIN_AGE_MS;
  const now = opts.now ?? Date.now();
  const found: StaleGitLock[] = [];
  const consider = (path: string, st: Stats | null): void => {
    if (!st || !st.isFile()) return;
    const ageMs = now - st.mtimeMs;
    if (ageMs >= minAgeMs) found.push({ path, repo, ageMs });
  };

  for (const name of TOP_LEVEL_LOCKS) {
    const path = join(commonDir, name);
    consider(path, lstatOrNull(path));
  }

  const worktreesDir = join(commonDir, 'worktrees');
  if (lstatOrNull(worktreesDir)?.isDirectory()) {
    let names: string[] = [];
    try {
      names = readdirSync(worktreesDir);
    } catch {
      names = [];
    }
    for (const wt of names) {
      const adminDir = join(worktreesDir, wt);
      if (!lstatOrNull(adminDir)?.isDirectory()) continue;
      for (const name of WORKTREE_LOCKS) {
        const path = join(adminDir, name);
        consider(path, lstatOrNull(path));
      }
    }
  }

  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_REF_DEPTH || visited >= MAX_REF_ENTRIES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > MAX_REF_ENTRIES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.lock')) consider(path, lstatOrNull(path));
    }
  };
  const refsDir = join(commonDir, 'refs');
  if (lstatOrNull(refsDir)?.isDirectory()) walk(refsDir, 0);

  return found;
}

/**
 * Stale lock files across `repos`, each common git dir scanned once (sandbox
 * worktrees and their source repo share one). Repos that are not git
 * repositories are skipped. Never throws.
 */
export function findStaleGitLocks(repos: readonly string[], opts: FindStaleGitLocksOptions = {}): StaleGitLock[] {
  const seen = new Set<string>();
  const found: StaleGitLock[] = [];
  for (const repo of repos) {
    const commonDir = gitCommonDir(repo);
    if (!commonDir || seen.has(commonDir)) continue;
    seen.add(commonDir);
    try {
      found.push(...findStaleGitLocksInCommonDir(commonDir, repo, opts));
    } catch {
      // Best-effort report: an unreadable repo contributes nothing.
    }
  }
  return found;
}

/** One-line human summary, e.g. for a doctor detail or an audit row. */
export function describeStaleGitLocks(locks: readonly StaleGitLock[]): string {
  if (locks.length === 0) return 'no stale git lock files';
  const first = locks[0]!;
  const mins = Math.floor(first.ageMs / 60_000);
  const more = locks.length > 1 ? ` (+${locks.length - 1} more)` : '';
  return `${locks.length} stale git lock file${locks.length !== 1 ? 's' : ''}: ` +
    `${first.path} (${mins} min old)${more}`;
}
