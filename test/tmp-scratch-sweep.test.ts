/**
 * Crash leftovers in ~/.ashlr/tmp that are not merge temp worktrees:
 *   - private scratch: `verify-confine-*` (inbox/merge.ts), `fleet-git-*`
 *     (fleet/host-merge.ts), `patch-*.diff` (inbox/apply.ts), swept by
 *     sweepLeakedTmpScratch with the temp-worktree owner rules;
 *   - inbox/apply.ts's `wt-<hex>` worktree, now owner-marked and reaped by
 *     the temp-worktree reaper, which keeps its `ashlr/proposal/…` branch.
 *
 * HERMETIC: HOME / ASHLR_HOME point at a tmp dir (h1 fixture), repos are tmp
 * git repos, dead owners are real exited child processes, no network.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS,
  ashlrTmpDir,
  reapLeakedTempWorktrees,
  releaseTmpScratchOwner,
  sweepLeakedTempWorktreesAtStart,
  sweepLeakedTmpScratch,
  writeTmpScratchOwner,
} from '../src/core/inbox/temp-worktree-reaper.js';
import { openGitScratch, closeGitScratch } from '../src/core/fleet/host-merge.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  expect(typeof r.pid).toBe('number');
  return r.pid as number;
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function tmp(name: string): string {
  fs.mkdirSync(ashlrTmpDir(), { recursive: true });
  return path.join(ashlrTmpDir(), name);
}

function deadMarker(p: string): void {
  fs.writeFileSync(`${p}.owner`, `${JSON.stringify({ schemaVersion: 1, pid: deadPid() })}\n`, 'utf8');
}

function backdate(p: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(p, t, t);
}

describe('sweepLeakedTmpScratch', () => {
  it('reaps dead-owner scratch of every kind and keeps a live owner\'s', () => {
    fx = makeFixture();
    const confine = tmp('verify-confine-Ab12Cd');
    fs.mkdirSync(path.join(confine, 'cargo-runtime'), { recursive: true });
    fs.writeFileSync(path.join(confine, 'cargo-runtime', 'x'), 'x');
    deadMarker(confine);
    const fleet = tmp('fleet-git-Zz9Yy8');
    fs.mkdirSync(fleet);
    deadMarker(fleet);
    const patch = tmp('patch-0123456789ab.diff');
    fs.writeFileSync(patch, 'diff');
    deadMarker(patch);
    const live = tmp('fleet-git-LIVE01');
    fs.mkdirSync(live);
    writeTmpScratchOwner(live);

    const r = sweepLeakedTmpScratch();
    expect(r.reaped.sort()).toEqual([confine, fleet, patch].sort());
    expect(r.kept).toEqual([live]);
    for (const p of [confine, fleet, patch]) {
      expect(fs.existsSync(p)).toBe(false);
      expect(fs.existsSync(`${p}.owner`)).toBe(false);
    }
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(`${live}.owner`)).toBe(true);
  });

  it('reaps markerless scratch only once it is old, and drops orphan dead markers', () => {
    fx = makeFixture();
    const young = tmp('verify-confine-young1');
    fs.mkdirSync(young);
    const old = tmp('verify-confine-old001');
    fs.mkdirSync(old);
    backdate(old, MARKERLESS_TEMP_WORKTREE_REAP_AGE_MS + 60_000);
    const orphan = tmp('patch-aaaaaaaaaaaa.diff');
    deadMarker(orphan); // the patch file itself is already gone

    const r = sweepLeakedTmpScratch();
    expect(r.reaped.sort()).toEqual([old, orphan].sort());
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(`${orphan}.owner`)).toBe(false);
  });

  it('never follows or removes a symlink and ignores names outside the scratch patterns', () => {
    fx = makeFixture();
    const target = path.join(fx.home, 'precious');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'keep');
    const link = tmp('fleet-git-Link01');
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch {
      return; // symlinks unavailable (unprivileged Windows): nothing to prove
    }
    deadMarker(link);
    const other = tmp('verify-confine-toolong7');
    fs.mkdirSync(other);
    deadMarker(other);
    const unrelated = tmp('something-else');
    fs.mkdirSync(unrelated);

    const r = sweepLeakedTmpScratch();
    expect(r.reaped).toEqual([]);
    expect(fs.existsSync(path.join(target, 'keep'))).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('fleet scratch repositories carry a marker that close drops', () => {
    fx = makeFixture();
    const repo = fx.makeRepo();
    const scratch = openGitScratch(repo.dir);
    if (typeof scratch === 'string') throw new Error(scratch);
    expect(path.basename(scratch.dir)).toMatch(/^fleet-git-/);
    expect(fs.existsSync(`${scratch.dir}.owner`)).toBe(true);
    closeGitScratch(scratch);
    expect(fs.existsSync(scratch.dir)).toBe(false);
    expect(fs.existsSync(`${scratch.dir}.owner`)).toBe(false);
  });

  it('release keeps the marker while the scratch still exists', () => {
    fx = makeFixture();
    const p = tmp('patch-bbbbbbbbbbbb.diff');
    writeTmpScratchOwner(p);
    fs.writeFileSync(p, 'diff');
    releaseTmpScratchOwner(p);
    expect(fs.existsSync(`${p}.owner`)).toBe(true);
    fs.unlinkSync(p);
    releaseTmpScratchOwner(p);
    expect(fs.existsSync(`${p}.owner`)).toBe(false);
  });
});

describe('inbox/apply wt- worktrees', () => {
  it('a dead-owner wt- leftover is reaped and its proposal branch is kept', async () => {
    fx = makeFixture();
    const repo = fx.makeRepo();
    const dir = tmp('wt-c0ffeec0ffee');
    git(repo.dir, ['worktree', 'add', '-b', 'ashlr/proposal/prop-1', dir, repo.branch]);
    fs.writeFileSync(`${dir}.owner`, `${JSON.stringify({ schemaVersion: 1, pid: deadPid(), repo: path.resolve(repo.dir) })}\n`);

    const swept = await sweepLeakedTempWorktreesAtStart();
    expect(swept.reaped).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(repo.dir, ['worktree', 'list', '--porcelain'])).not.toContain('wt-c0ffeec0ffee');
    expect(repo.branches()).toContain('ashlr/proposal/prop-1');
    // A second reap finds nothing left.
    expect(reapLeakedTempWorktrees(repo.dir).reaped).toEqual([]);
  });
});
