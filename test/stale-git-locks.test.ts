/**
 * Read-only detection of git lock files left by a git process killed
 * mid-update (src/core/sandbox/stale-git-locks.ts), its readiness facet and
 * the `git-locks` doctor probe.
 *
 * Proves with real git repos under an isolated tmp HOME:
 *   - old packed-refs.lock, nested ref .lock, top-level HEAD.lock and a linked
 *     worktree's index.lock are reported; young locks are not;
 *   - a symlinked lock and non-lock files are ignored;
 *   - nothing is ever removed, and the repo's ref updates still fail until
 *     the owner removes the lock (so the report is the whole remedy);
 *   - a worktree and its source repo are scanned once (shared common dir);
 *   - readGitLockHealth covers enrolled repos, and doctor warns with a fix hint.
 *
 * HERMETIC: HOME / ASHLR_HOME point at a tmp dir (h1 fixture), repos are tmp
 * git repos, no network.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  STALE_GIT_LOCK_MIN_AGE_MS,
  describeStaleGitLocks,
  findStaleGitLocks,
  gitCommonDir,
} from '../src/core/sandbox/stale-git-locks.js';
import { readGitLockHealth } from '../src/core/readiness.js';
import { runDoctor } from '../src/core/doctor.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Write a lock file and backdate its mtime by `ageMs`. */
function plantLock(file: string, ageMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}

const OLD = STALE_GIT_LOCK_MIN_AGE_MS + 60_000;

describe('findStaleGitLocks', () => {
  it('reports old ref, packed-refs, HEAD and worktree index locks and ignores young ones', () => {
    fx = makeFixture();
    const repo = fx.makeRepo();
    const common = gitCommonDir(repo.dir)!;
    const wtDir = path.join(path.dirname(repo.dir), `${path.basename(repo.dir)}-wt`);
    git(repo.dir, ['worktree', 'add', '-q', '-b', 'side', wtDir]);
    try {
      const adminName = fs.readdirSync(path.join(common, 'worktrees'))[0]!;
      plantLock(path.join(common, 'packed-refs.lock'), OLD);
      plantLock(path.join(common, 'refs', 'heads', 'ashlr', 'sb', 'x.lock'), OLD);
      plantLock(path.join(common, 'HEAD.lock'), OLD);
      plantLock(path.join(common, 'worktrees', adminName, 'index.lock'), OLD);
      plantLock(path.join(common, 'refs', 'heads', 'young.lock'), 1_000);
      plantLock(path.join(common, 'refs', 'heads', 'notalock'), OLD);

      const found = findStaleGitLocks([repo.dir, wtDir]);
      const rel = found.map((l) => path.relative(common, l.path)).sort();
      expect(rel).toEqual([
        'HEAD.lock',
        'packed-refs.lock',
        path.join('refs', 'heads', 'ashlr', 'sb', 'x.lock'),
        path.join('worktrees', adminName, 'index.lock'),
      ].sort());
      // Scanned once although both the repo and its worktree were passed.
      expect(new Set(found.map((l) => l.repo))).toEqual(new Set([repo.dir]));
      for (const l of found) expect(l.ageMs).toBeGreaterThanOrEqual(STALE_GIT_LOCK_MIN_AGE_MS);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', wtDir], { cwd: repo.dir });
    }
  });

  it('never removes a lock, and the blocked ref update stays blocked until the owner does', () => {
    fx = makeFixture();
    const repo = fx.makeRepo();
    const lock = path.join(gitCommonDir(repo.dir)!, 'refs', 'heads', 'feature.lock');
    plantLock(lock, OLD);

    expect(findStaleGitLocks([repo.dir])).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(true);
    const blocked = spawnSync('git', ['branch', 'feature'], { cwd: repo.dir, encoding: 'utf8' });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/\.lock/);

    fs.unlinkSync(lock);
    expect(findStaleGitLocks([repo.dir])).toEqual([]);
    expect(spawnSync('git', ['branch', 'feature'], { cwd: repo.dir }).status).toBe(0);
  });

  it('ignores a symlinked lock and skips paths that are not git repos', () => {
    fx = makeFixture();
    const repo = fx.makeRepo();
    const common = gitCommonDir(repo.dir)!;
    const target = path.join(fx.home, 'elsewhere.lock');
    plantLock(target, OLD);
    try {
      fs.symlinkSync(target, path.join(common, 'packed-refs.lock'));
    } catch {
      return; // symlinks unavailable (unprivileged Windows): nothing to prove
    }
    const notRepo = fs.mkdtempSync(path.join(fx.home, 'plain-'));
    expect(findStaleGitLocks([repo.dir, notRepo, path.join(fx.home, 'missing')])).toEqual([]);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('summarises for doctor and audit rows', () => {
    expect(describeStaleGitLocks([])).toBe('no stale git lock files');
    const s = describeStaleGitLocks([
      { path: '/r/.git/packed-refs.lock', repo: '/r', ageMs: 25 * 60_000 },
      { path: '/r/.git/HEAD.lock', repo: '/r', ageMs: 11 * 60_000 },
    ]);
    expect(s).toBe('2 stale git lock files: /r/.git/packed-refs.lock (25 min old) (+1 more)');
  });
});

describe('git-locks readiness facet and doctor probe', () => {
  it('scans enrolled repos and warns in doctor with a check-first fix hint', async () => {
    fx = makeFixture();
    const repo = fx.makeRepo();
    repo.enroll();
    expect(readGitLockHealth()).toEqual({ repos: 1, locks: [] });

    const lock = path.join(gitCommonDir(repo.dir)!, 'packed-refs.lock');
    plantLock(lock, OLD);
    const health = readGitLockHealth();
    expect(health.locks.map((l) => l.path)).toEqual([lock]);

    const report = await runDoctor(makeCfg());
    const probe = report.checks.find((c) => c.id === 'git-locks');
    expect(probe?.status).toBe('warn');
    expect(probe?.detail).toContain(lock);
    expect(probe?.fix).toContain('If no git process is running');
    expect(fs.existsSync(lock)).toBe(true);
  }, 60_000);
});
