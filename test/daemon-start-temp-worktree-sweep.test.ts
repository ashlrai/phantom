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
  tempWorktreeOwningRepo,
  writeTempWorktreeOwner,
} from '../src/core/inbox/temp-worktree-reaper.js';
import { runDaemon } from '../src/core/daemon/loop.js';
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
function leakDeadOwner(name: string, branch: string): string {
  fs.mkdirSync(ashlrTmpDir(), { recursive: true });
  const dir = path.join(ashlrTmpDir(), name);
  git(repo.dir, ['worktree', 'add', '-b', branch, dir, repo.branch]);
  fs.writeFileSync(`${dir}.owner`, `${JSON.stringify({ schemaVersion: 1, pid: deadPid() })}\n`, 'utf8');
  return dir;
}

/** A worktree another live process (here: this one) is still using. */
function liveOwner(name: string): string {
  const dir = path.join(ashlrTmpDir(), name);
  writeTempWorktreeOwner(dir);
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
});
