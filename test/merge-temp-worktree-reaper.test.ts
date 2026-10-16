/**
 * Crash-leftover reaper for inbox/merge.ts temp worktrees (vwt-/mwt-/mergewt-).
 *
 * A daemon SIGKILLed / OOM-killed mid-verify never runs the `finally` that
 * removes its temp worktree, so the directory, its registration and the
 * `ashlr/verify/<hex>` branch leaked forever. These tests model that leak with
 * real git worktrees and owner markers and check the reaper's fail-closed rules.
 *
 * HERMETIC: HOME points at a tmp dir, repos are real tmp git repos, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  ashlrTmpDir,
  MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS,
  reapLeakedTempWorktrees,
  releaseTempWorktreeOwner,
  writeTempWorktreeOwner,
} from '../src/core/inbox/temp-worktree-reaper.js';
import { verifyProposal } from '../src/core/inbox/merge.js';
import { verifiedProcessStartIdentity } from '../src/core/fleet/local-store-lock.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const origHome = process.env.HOME;
let tmpHome: string;
let repo: string;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '--initial-branch=main', dir], { stdio: 'pipe' });
  git(dir, ['config', 'user.email', 'test@ashlr.test']);
  git(dir, ['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

/** A pid that provably belonged to a process which has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  expect(typeof r.pid).toBe('number');
  return r.pid as number;
}

function worktreePaths(dir: string): string[] {
  return git(dir, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => fs.realpathSync(l.slice('worktree '.length)));
}

function branches(dir: string): string[] {
  return git(dir, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean);
}

/** Leak a verify-style worktree (detached for mwt-, branched for vwt-). */
function leak(name: string, branch: string | null, base = ashlrTmpDir()): string {
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, name);
  if (branch) git(repo, ['worktree', 'add', '-b', branch, dir, 'main']);
  else git(repo, ['worktree', 'add', '--detach', dir, 'main']);
  return dir;
}

function writeMarker(dir: string, body: Record<string, unknown>): void {
  fs.writeFileSync(`${dir}.owner`, `${JSON.stringify(body)}\n`, 'utf8');
}

function real(p: string): string {
  return fs.realpathSync(p);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-reaper-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-reaper-repo-'));
  process.env.HOME = tmpHome;
  initRepo(repo);
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('temp worktree reaper', () => {
  it('reaps a dead-owner leaked verify worktree, its marker and its ashlr/verify branch', () => {
    const dir = leak('vwt-0a1b2c3d4e5f', 'ashlr/verify/aabbccddeeff');
    writeMarker(dir, { schemaVersion: 1, pid: deadPid() });
    const res = reapLeakedTempWorktrees(repo);
    expect(res.reaped).toHaveLength(1);
    expect(res.branchesDeleted).toEqual(['ashlr/verify/aabbccddeeff']);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(`${dir}.owner`)).toBe(false);
    expect(worktreePaths(repo)).toEqual([real(repo)]);
    expect(branches(repo)).toEqual(['main']);
  });

  it('reaps a worktree whose live pid was reused by a different process', () => {
    const dir = leak('mwt-00ff00ff00ff', null);
    const own = verifiedProcessStartIdentity(process.pid);
    expect(own).toBeDefined();
    // Our own pid, but a start reference that cannot be ours: pid reuse.
    writeMarker(dir, { schemaVersion: 1, pid: process.pid, startRef: '1'.padStart(64, '0'), startSource: own!.source });
    const res = reapLeakedTempWorktrees(repo);
    expect(res.reaped).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps a worktree whose owner is alive (marker written by this process)', () => {
    const dir = path.join(ashlrTmpDir(), 'vwt-123456abcdef');
    writeTempWorktreeOwner(dir);
    git(repo, ['worktree', 'add', '-b', 'ashlr/verify/123456abcdef', dir, 'main']);
    const res = reapLeakedTempWorktrees(repo, { now: Date.now() + 10 * MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS });
    expect(res.reaped).toEqual([]);
    expect(res.kept).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(true);
    expect(branches(repo)).toContain('ashlr/verify/123456abcdef');
    // Owner marker survives while the directory exists; released once it is gone.
    releaseTempWorktreeOwner(dir);
    expect(fs.existsSync(`${dir}.owner`)).toBe(true);
    git(repo, ['worktree', 'remove', '--force', dir]);
    releaseTempWorktreeOwner(dir);
    expect(fs.existsSync(`${dir}.owner`)).toBe(false);
  });

  it('keeps a recent markerless leftover and reaps it only past the conservative age', () => {
    const dir = leak('mergewt-abcdef012345', 'some-base');
    const kept = reapLeakedTempWorktrees(repo);
    expect(kept.reaped).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);

    const aged = reapLeakedTempWorktrees(repo, { now: Date.now() + MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS + 60_000 });
    expect(aged.reaped).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(false);
    // mergewt- holds a real branch (the default branch in production): never deleted.
    expect(aged.branchesDeleted).toEqual([]);
    expect(branches(repo)).toContain('some-base');
  });

  it('treats a corrupt marker like a missing one (kept while recent)', () => {
    const dir = leak('vwt-feedfacecafe', 'ashlr/verify/feedfacecafe');
    fs.writeFileSync(`${dir}.owner`, 'not json', 'utf8');
    expect(reapLeakedTempWorktrees(repo).reaped).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('never touches non-matching names, paths outside the tmp dir, or non-verify branches', () => {
    const pid = deadPid();
    const badName = leak('vwt-NOTHEX', 'ashlr/verify/111111111111');
    writeMarker(badName, { pid });
    const otherPrefix = leak('swt-abcdefabcdef', 'ashlr/verify/222222222222');
    writeMarker(otherPrefix, { pid });
    const nestedBase = path.join(ashlrTmpDir(), 'nested');
    const nested = leak('vwt-abcabcabcabc', 'ashlr/verify/333333333333', nestedBase);
    writeMarker(nested, { pid });
    const outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-reaper-outside-'));
    const outside = leak('vwt-defdefdefdef', 'ashlr/verify/444444444444', outsideBase);
    writeMarker(outside, { pid });
    // Matching worktree, dead owner, but a branch that is not ashlr/verify/<hex>.
    const odd = leak('vwt-0123456789ab', 'feature/keep-me');
    writeMarker(odd, { pid });

    try {
      const res = reapLeakedTempWorktrees(repo, { now: Date.now() + 10 * MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS });
      expect(res.reaped.map((p) => path.basename(p))).toEqual(['vwt-0123456789ab']);
      expect(res.branchesDeleted).toEqual([]);
      for (const d of [badName, otherPrefix, nested, outside]) expect(fs.existsSync(d)).toBe(true);
      expect(fs.existsSync(odd)).toBe(false);
      expect(branches(repo).sort()).toEqual([
        'ashlr/verify/111111111111',
        'ashlr/verify/222222222222',
        'ashlr/verify/333333333333',
        'ashlr/verify/444444444444',
        'feature/keep-me',
        'main',
      ]);
    } finally {
      fs.rmSync(outsideBase, { recursive: true, force: true });
    }
  });

  it('verifyProposal reaps a dead-owner leftover before creating its own worktree, and leaves none', async () => {
    const dir = leak('vwt-deaddeaddead', 'ashlr/verify/deaddeaddead');
    writeMarker(dir, { schemaVersion: 1, pid: deadPid() });
    const proposal = {
      id: 'prop-reaper',
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 't',
      summary: 't',
      status: 'pending',
      createdAt: new Date().toISOString(),
      diff: [
        'diff --git a/docs/x.md b/docs/x.md',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/docs/x.md',
        '@@ -0,0 +1 @@',
        '+doc',
        '',
      ].join('\n'),
    } as Proposal;
    const cfg = { foundry: { autoMerge: { enabled: true, allowWithoutVerification: true } } } as unknown as AshlrConfig;
    await verifyProposal(proposal, cfg);
    expect(worktreePaths(repo)).toEqual([real(repo)]);
    expect(branches(repo)).toEqual(['main']);
    const leftovers = fs.readdirSync(ashlrTmpDir()).filter((n) => /^(vwt|mwt|mergewt)-/.test(n));
    expect(leftovers).toEqual([]);
  });
});
