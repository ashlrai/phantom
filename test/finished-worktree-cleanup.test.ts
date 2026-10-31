import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const git = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFileSync: git.run,
}));

import {
  ashlrTmpDir, reapLeakedTempWorktrees, reclaimableTempWorktrees, removeTempWorktree,
} from '../src/core/inbox/temp-worktree-reaper.js';
import { checkWorktreeStorage } from '../src/core/doctor.js';

let home: string;
let repo: string;
let dir: string;
let dirty: boolean;
let locked: boolean;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'finished-worktree-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  repo = join(home, 'repo');
  dir = join(ashlrTmpDir(), 'wt-abcdef');
  mkdirSync(repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'source');
  writeFileSync(`${dir}.owner`, JSON.stringify({ pid: 1234567 }));
  dirty = false;
  locked = false;
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  git.run.mockReset().mockImplementation((_command: string, args: string[]) => {
    const worktree = args.indexOf('worktree');
    if (worktree >= 0 && args[worktree + 1] === 'list') {
      return `worktree ${repo}\nbranch refs/heads/main\n\nworktree ${dir}\nbranch refs/heads/proposal\n${locked ? 'locked FIXUP\n' : ''}\n`;
    }
    if (worktree >= 0 && args[worktree + 1] === 'remove') {
      if (dirty || locked) throw new Error('git refused removal');
      rmSync(args[worktree + 2]!, { recursive: true });
    }
    if (args.includes('status')) return dirty ? ' M README.md' : '';
    return '';
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const removals = (): string[][] => git.run.mock.calls
  .map((call) => call[1] as string[])
  .filter((args) => args.includes('remove'));

describe('finished inbox cleanup policy', () => {
  it('immediately removes an owned finished checkout without force and releases its marker', () => {
    expect(removeTempWorktree(repo, dir)).toBe(true);
    expect(removals()).toHaveLength(1);
    expect(removals()[0]!.slice(-3)).toEqual(['worktree', 'remove', dir]);
    expect(removals()[0]).not.toContain('--force');
    expect(existsSync(`${dir}.owner`)).toBe(false);
  });

  it.each(['pin', 'malformed'])('keeps a %s FIXUP policy and recovery marker', (kind) => {
    writeFileSync(join(home, '.ashlr', 'kept-worktrees.json'), kind === 'pin' ? JSON.stringify([dir]) : '{bad');
    expect(removeTempWorktree(repo, dir)).toBe(false);
    expect(reapLeakedTempWorktrees(repo).kept).toContain(dir);
    expect(removals()).toEqual([]);
    expect(existsSync(`${dir}.owner`)).toBe(true);
  });

  it('retains Git refusals and their recovery marker without a recursive deletion fallback', () => {
    dirty = true;
    expect(reapLeakedTempWorktrees(repo).failed).toContain(dir);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('source');
    expect(existsSync(`${dir}.owner`)).toBe(true);
  });

  it('keeps locked worktrees before asking Git to remove them', () => {
    locked = true;
    expect(reapLeakedTempWorktrees(repo).kept).toContain(dir);
    expect(removals()).toEqual([]);
  });

  it('refuses paths outside the managed worktree root', () => {
    const outside = join(home, 'wt-deadbeef');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'outside');
    expect(removeTempWorktree(repo, outside)).toBe(false);
    expect(removeTempWorktree(repo, resolve(ashlrTmpDir(), '..', '..', 'wt-deadbeef'))).toBe(false);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside');
    expect(removals()).toEqual([]);
  });

  it('refuses a worktree replaced with a symlink', () => {
    rmSync(dir, { recursive: true });
    symlinkSync(repo, dir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(removeTempWorktree(repo, dir)).toBe(false);
    expect(removals()).toEqual([]);
    expect(existsSync(repo)).toBe(true);
  });

  it('reports only clean unlocked unpinned inactive worktrees without mutations', () => {
    expect(reclaimableTempWorktrees(repo)).toEqual({ paths: [dir], complete: true });
    expect(git.run.mock.calls.some((call) => (call[1] as string[]).includes('--no-optional-locks'))).toBe(true);
    dirty = true;
    expect(reclaimableTempWorktrees(repo).paths).toEqual([]);
    dirty = false;
    locked = true;
    expect(reclaimableTempWorktrees(repo).paths).toEqual([]);
    expect(removals()).toEqual([]);
  });
});

describe('doctor reclaimable storage line', () => {
  it('formats decimal GB with an explicit scope and estimate', () => {
    expect(checkWorktreeStorage(() => ({ bytes: 2_500_000_000, worktrees: 3, complete: true })))
      .toMatchObject({ status: 'warn', detail: expect.stringContaining('2.50 GB reclaimable (logical estimate) in 3 clean inactive inbox worktrees') });
  });
  it('distinguishes empty scans from incomplete and unavailable scans', () => {
    expect(checkWorktreeStorage(() => ({ bytes: 0, worktrees: 0, complete: true })).status).toBe('pass');
    expect(checkWorktreeStorage(() => ({ bytes: 0, worktrees: 0, complete: false })))
      .toMatchObject({ status: 'warn', detail: expect.stringContaining('total unknown') });
    expect(checkWorktreeStorage(() => { throw new Error('unreadable'); }))
      .toMatchObject({ status: 'warn', detail: expect.stringContaining('GB unknown') });
  });
});
