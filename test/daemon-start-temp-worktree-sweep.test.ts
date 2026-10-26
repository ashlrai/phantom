/**
 * Daemon-start sweep of leaked inbox/merge temp worktrees
 * (`~/.ashlr/tmp/{vwt,mwt,mergewt}-*`).
 *
 * A daemon killed mid-verify/merge leaks its temp worktree. Before this sweep
 * the leftover survived until the next merge in that repo; runDaemon now runs
 * the reaper once at start. These tests prove, with real git worktrees under an
 * isolated tmp HOME:
 *   - a dead-owner leftover is reaped at daemon start (dir, marker, branch);
 *   - a live-owner worktree (marker written by this running process) is kept;
 *   - a leftover whose directory is gone is traced through the repo recorded
 *     in its owner marker and its registration is pruned at start, while an
 *     old-format marker without that field behaves exactly as before;
 *   - a failing sweep never stops daemon start.
 *
 * HERMETIC: HOME / ASHLR_HOME point at a tmp dir (h1 fixture), repos are tmp
 * git repos, no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  ashlrTmpDir,
  leakedTempWorktreeRepos,
  sweepLeakedTempWorktreesAtStart,
  tempWorktreeMarkerRepo,
  tempWorktreeOwningRepo,
  writeTempWorktreeOwner,
} from '../src/core/inbox/temp-worktree-reaper.js';
import { runDaemon } from '../src/core/daemon/loop.js';
import { setKill, killSwitchOn } from '../src/core/sandbox/policy.js';
import { acquireOutwardMutationFence, releaseOutwardMutationFence } from '../src/core/sandbox/mutation-fence.js';
import { makeFixture, makeCfg, type H1Fixture, type DisposableRepo } from './helpers/h1-fixture.js';

vi.mock('../src/core/daemon/activation-permit.js', () => ({
  consumeDaemonActivationPermit: () => ({
    authorized: true,
    required: false,
    reason: 'test-authorized',
  }),
  isDaemonActivationCapability: () => true,
}));

const sweepControl = vi.hoisted(() => ({ fail: false, calls: 0 }));

vi.mock('../src/core/inbox/temp-worktree-reaper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/temp-worktree-reaper.js')>();
  return {
    ...actual,
    sweepLeakedTempWorktreesAtStart: async (
      ...args: Parameters<typeof actual.sweepLeakedTempWorktreesAtStart>
    ) => {
      sweepControl.calls += 1;
      if (sweepControl.fail) throw new Error('simulated reaper failure');
      return actual.sweepLeakedTempWorktreesAtStart(...args);
    },
  };
});

let fx: H1Fixture | undefined;
let repo: DisposableRepo;

afterEach(() => {
  sweepControl.fail = false;
  sweepControl.calls = 0;
  vi.restoreAllMocks();
  fx?.cleanup();
  fx = undefined;
});

function setup(): void {
  fx = makeFixture();
  repo = fx.makeRepo();
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** A pid that provably belonged to a process which has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  expect(typeof r.pid).toBe('number');
  return r.pid as number;
}

function worktreeNames(dir: string): string[] {
  return git(dir, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.basename(l.slice('worktree '.length)));
}

/** A leftover from a killed daemon: registered worktree + a dead-owner marker. */
function leakDeadOwner(name: string, branch: string, extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(ashlrTmpDir(), { recursive: true });
  const dir = path.join(ashlrTmpDir(), name);
  git(repo.dir, ['worktree', 'add', '-b', branch, dir, repo.branch]);
  fs.writeFileSync(`${dir}.owner`, `${JSON.stringify({ schemaVersion: 1, pid: deadPid(), ...extra })}\n`, 'utf8');
  return dir;
}

/** A worktree another live process (here: this one) is still using. */
function liveOwner(name: string): string {
  const dir = path.join(ashlrTmpDir(), name);
  writeTempWorktreeOwner(dir, repo.dir);
  git(repo.dir, ['worktree', 'add', '--detach', dir, repo.branch]);
  return dir;
}

describe('daemon start sweeps leaked temp worktrees', () => {
  it('resolves the owning repo from the leftover .git pointer and ignores non-worktree dirs', () => {
    setup();
    const dir = leakDeadOwner('vwt-a1a1a1a1a1a1', 'ashlr/verify/a1a1a1a1a1a1');
    fs.mkdirSync(path.join(ashlrTmpDir(), 'mwt-ffffffffffff'));
    fs.mkdirSync(path.join(ashlrTmpDir(), 'not-a-temp-worktree'));
    expect(fs.realpathSync(tempWorktreeOwningRepo(dir)!)).toBe(fs.realpathSync(repo.dir));
    expect(tempWorktreeOwningRepo(path.join(ashlrTmpDir(), 'mwt-ffffffffffff'))).toBeNull();
    expect(leakedTempWorktreeRepos().map((r) => fs.realpathSync(r))).toEqual([fs.realpathSync(repo.dir)]);
  });

  it('reaps a dead-owner leftover at runDaemon start and keeps a live-owner worktree', async () => {
    setup();
    const dead = leakDeadOwner('vwt-0a1b2c3d4e5f', 'ashlr/verify/0a1b2c3d4e5f');
    const live = liveOwner('mergewt-123456abcdef');

    const state = await runDaemon(makeCfg(), { once: true, dryRun: false });
    expect(state.startRefusal).toBeUndefined();
    expect(sweepControl.calls).toBe(1);

    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(`${dead}.owner`)).toBe(false);
    expect(repo.branches()).not.toContain('ashlr/verify/0a1b2c3d4e5f');
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(`${live}.owner`)).toBe(true);
    expect(worktreeNames(repo.dir)).toContain('mergewt-123456abcdef');
    expect(worktreeNames(repo.dir)).not.toContain('vwt-0a1b2c3d4e5f');
  });

  it('a dry-run start does not sweep', async () => {
    setup();
    const dead = leakDeadOwner('mwt-0f0f0f0f0f0f', 'leak-mwt');
    await runDaemon(makeCfg(), { once: true, dryRun: true });
    expect(sweepControl.calls).toBe(0);
    expect(fs.existsSync(dead)).toBe(true);
  });

  it('a failing sweep does not stop daemon start', async () => {
    setup();
    const dead = leakDeadOwner('vwt-feedfacecafe', 'ashlr/verify/feedfacecafe');
    sweepControl.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const state = await runDaemon(makeCfg(), { once: true, dryRun: false });

    expect(sweepControl.calls).toBe(1);
    expect(state.startRefusal).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('temp worktree sweep failed'))).toBe(true);
    expect(fs.existsSync(dead)).toBe(true);
  });

  it('writeTempWorktreeOwner records the owning repo as an absolute path', () => {
    setup();
    const dir = liveOwner('mwt-5e5e5e5e5e5e');
    const marker = JSON.parse(fs.readFileSync(`${dir}.owner`, 'utf8')) as Record<string, unknown>;
    expect(marker['repo']).toBe(path.resolve(repo.dir));
    expect(marker['pid']).toBe(process.pid);
    expect(tempWorktreeMarkerRepo(`${dir}.owner`)).toBe(path.resolve(repo.dir));
  });

  it('prunes a dead-owner registration at start when only the marker (with repo) survives', async () => {
    setup();
    const dead = leakDeadOwner('mergewt-d1d1d1d1d1d1', 'leak-mergewt-d1', { repo: path.resolve(repo.dir) });
    fs.rmSync(dead, { recursive: true, force: true });
    expect(worktreeNames(repo.dir)).toContain('mergewt-d1d1d1d1d1d1');
    expect(leakedTempWorktreeRepos()).toEqual([path.resolve(repo.dir)]);

    const state = await runDaemon(makeCfg(), { once: true, dryRun: false });
    expect(state.startRefusal).toBeUndefined();
    expect(sweepControl.calls).toBe(1);

    expect(worktreeNames(repo.dir)).not.toContain('mergewt-d1d1d1d1d1d1');
    expect(fs.existsSync(`${dead}.owner`)).toBe(false);
    // mergewt- holds a base branch the reaper never deletes.
    expect(repo.branches()).toContain('leak-mergewt-d1');
  });

  it('keeps a live-owner registration traced only by its marker', async () => {
    setup();
    const live = liveOwner('mwt-1e1e1e1e1e1e');
    fs.rmSync(live, { recursive: true, force: true });
    const result = await sweepLeakedTempWorktreesAtStart();
    expect(result).toMatchObject({ repos: 1, reaped: 0, kept: 1 });
    expect(worktreeNames(repo.dir)).toContain('mwt-1e1e1e1e1e1e');
    expect(fs.existsSync(`${live}.owner`)).toBe(true);
  });

  it('an old-format marker (no repo) with its directory present is traced and reaped as before', async () => {
    setup();
    const present = leakDeadOwner('vwt-0d0d0d0d0d0d', 'ashlr/verify/0d0d0d0d0d0d');
    expect(tempWorktreeMarkerRepo(`${present}.owner`)).toBeNull();
    const result = await sweepLeakedTempWorktreesAtStart();
    expect(result).toMatchObject({ repos: 1, reaped: 1, kept: 0 });
    expect(fs.existsSync(present)).toBe(false);
    expect(fs.existsSync(`${present}.owner`)).toBe(false);
    expect(repo.branches()).not.toContain('ashlr/verify/0d0d0d0d0d0d');
    expect(worktreeNames(repo.dir)).not.toContain('vwt-0d0d0d0d0d0d');
  });

  it('an old-format marker (no repo) with its directory gone is untraceable, as before', async () => {
    setup();
    const gone = leakDeadOwner('mwt-0e0e0e0e0e0e', 'leak-mwt-0e');
    fs.rmSync(gone, { recursive: true, force: true });
    expect(leakedTempWorktreeRepos()).toEqual([]);
    const result = await sweepLeakedTempWorktreesAtStart();
    expect(result).toMatchObject({ repos: 0, reaped: 0 });
    // Left for the next merge in that repo, whose reaper still handles it.
    expect(worktreeNames(repo.dir)).toContain('mwt-0e0e0e0e0e0e');
    expect(fs.existsSync(`${gone}.owner`)).toBe(true);
  });

  it('ignores a marker repo that is relative, missing, not a directory or not a git repo', () => {
    setup();
    fs.mkdirSync(ashlrTmpDir(), { recursive: true });
    const plainDir = fs.mkdtempSync(path.join(path.dirname(repo.dir), 'not-a-repo-'));
    const plainFile = path.join(plainDir, 'file');
    fs.writeFileSync(plainFile, 'x');
    const bad: Array<[string, unknown]> = [
      ['vwt-b0b0b0b0b0b0', 'relative/repo'],
      ['vwt-b1b1b1b1b1b1', path.join(plainDir, 'missing')],
      ['vwt-b2b2b2b2b2b2', plainFile],
      ['vwt-b3b3b3b3b3b3', plainDir],
      ['vwt-b4b4b4b4b4b4', path.join(repo.dir, 'sub')],
      ['vwt-b5b5b5b5b5b5', 42],
    ];
    fs.mkdirSync(path.join(repo.dir, 'sub'), { recursive: true });
    for (const [name, value] of bad) {
      fs.writeFileSync(
        path.join(ashlrTmpDir(), `${name}.owner`),
        `${JSON.stringify({ schemaVersion: 1, pid: deadPid(), repo: value })}\n`,
      );
      expect(tempWorktreeMarkerRepo(path.join(ashlrTmpDir(), `${name}.owner`))).toBeNull();
    }
    fs.writeFileSync(path.join(ashlrTmpDir(), 'not-temp.owner'), JSON.stringify({ repo: path.resolve(repo.dir) }));
    expect(tempWorktreeMarkerRepo(path.join(ashlrTmpDir(), 'not-temp.owner'))).toBeNull();
    expect(leakedTempWorktreeRepos()).toEqual([]);
    fs.rmSync(plainDir, { recursive: true, force: true });
  });

  it('a throwing per-repo reaper is counted as skipped, never thrown', async () => {
    setup();
    leakDeadOwner('vwt-abababababab', 'ashlr/verify/abababababab');
    const result = await sweepLeakedTempWorktreesAtStart({
      reap: () => {
        throw new Error('boom');
      },
    });
    expect(result).toMatchObject({ repos: 1, reaped: 0, skippedRepos: 1 });
  });

  it('KILL armed after the daemon-start check stops the sweep before any repo is touched', async () => {
    setup();
    const dead = leakDeadOwner('vwt-c0c0c0c0c0c0', 'ashlr/verify/c0c0c0c0c0c0');
    expect(setKill(true).ok).toBe(true);
    try {
      expect(killSwitchOn()).toBe(true);
      const reap = vi.fn();
      const result = await sweepLeakedTempWorktreesAtStart({ reap });
      expect(reap).not.toHaveBeenCalled();
      expect(result).toMatchObject({ repos: 1, reaped: 0, skippedRepos: 1 });
      expect(fs.existsSync(dead)).toBe(true);
      expect(repo.branches()).toContain('ashlr/verify/c0c0c0c0c0c0');
    } finally {
      setKill(false);
    }
  });

  it('a held outward mutation fence skips the repo instead of mutating beside the holder', async () => {
    setup();
    const dead = leakDeadOwner('vwt-d0d0d0d0d0d0', 'ashlr/verify/d0d0d0d0d0d0');
    const fence = acquireOutwardMutationFence();
    expect(fence).not.toBeNull();
    try {
      const reap = vi.fn();
      const result = await sweepLeakedTempWorktreesAtStart({ reap, fenceWaitMs: 50 });
      expect(reap).not.toHaveBeenCalled();
      expect(result).toMatchObject({ repos: 1, skippedRepos: 1 });
      expect(fs.existsSync(dead)).toBe(true);
    } finally {
      releaseOutwardMutationFence(fence);
    }
  });
});
