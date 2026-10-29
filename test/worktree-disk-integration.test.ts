import type * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, worktreesHome } from '../src/core/verse/worktrees.js';
import { archiveWorkspace, createAgentWorkspace, restoreWorkspace } from '../src/core/verse/agents/workspace-ops.js';
import type { AgentArchiveRecord, AgentWorkspaceRecord } from '../src/core/verse/agents/types.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const mocks = vi.hoisted(() => ({ mkdir: vi.fn(async () => undefined), access: vi.fn(async () => undefined), reuse: vi.fn(async () => 'cloned') }));
vi.mock('../src/core/worktree-disk.js', async (original) => ({
  ...await original<typeof import('../src/core/worktree-disk.js')>(),
  reuseWorktreeNodeModules: mocks.reuse,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  mkdir: mocks.mkdir,
  access: mocks.access,
}));
vi.mock('../src/core/verse/git-ops.js', async (original) => ({
  ...await original<typeof import('../src/core/verse/git-ops.js')>(),
  resolveGitRoot: async (root: string) => root,
  withRepoLock: async (_root: string, action: () => Promise<unknown>) => action(),
}));

const root = resolve('/repository');
const workspace: AgentWorkspaceRecord = {
  rootPath: root, path: resolve('/worktrees/repository/finished'), branch: 'verse/finished', name: 'finished',
  portBase: 41000, portCount: 10, baseSha: 'a'.repeat(40),
};
const archive: AgentArchiveRecord = {
  at: '2026-10-26T00:00:00Z', ref: 'refs/ashlr/verse-archive/finished', sha: 'a'.repeat(40),
  headSha: 'a'.repeat(40), reason: 'manual', branchDeleted: false,
};

function fixture(free = 100n) {
  const events: string[] = [];
  const statfs = vi.fn(async () => { events.push('disk'); return { bsize: 1n, bavail: free }; });
  const makeDir = vi.fn(async () => { events.push('mkdir'); });
  const run = vi.fn(async (_cmd: string, args: readonly string[]) => {
    events.push(args.join(' '));
    return { code: args[0] === 'show-ref' ? 1 : 0, stdout: 'a'.repeat(40), stderr: '', timedOut: false };
  });
  const options = {
    runner: run as GitRunner,
    pathExists: () => false,
    probePath: async () => false,
    makeDir,
    disk: { fs: { statfs } as unknown as typeof fs, minFreeBytes: 100 },
  };
  return { events, statfs, makeDir, run, options };
}

beforeEach(() => vi.clearAllMocks());

describe('worktree creation disk admission', () => {
  it('refuses low free space before mkdir or git worktree add', async () => {
    const f = fixture(99n);
    await expect(createWorktree(root, 'task', f.options)).rejects.toMatchObject({ code: 'VERSE_GIT_REFUSED', status: 409 });
    expect(f.makeDir).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);
    expect(f.statfs).toHaveBeenCalledWith(join(worktreesHome(), 'repository'), { bigint: true });
  });

  it('refuses unknown capacity before mkdir or git worktree add', async () => {
    const f = fixture();
    f.statfs.mockRejectedValue(Object.assign(new Error('volume unavailable'), { code: 'EIO' }));
    await expect(createWorktree(root, 'task', f.options)).rejects.toMatchObject({ code: 'VERSE_GIT_REFUSED' });
    expect(f.makeDir).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);
  });

  it('rechecks the destination after mkdir and before adding the worktree', async () => {
    const f = fixture();
    const result = await createWorktree(root, 'task', f.options);
    const add = f.events.findIndex((event) => event.startsWith('worktree add'));
    expect(f.events.slice(add - 3, add)).toEqual(['disk', 'mkdir', 'disk']);
    expect(f.statfs).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ path: join(worktreesHome(), 'repository', 'task'), branch: 'verse/task' });
  });

  it('refuses add when capacity drops after mkdir', async () => {
    const f = fixture();
    f.statfs.mockResolvedValueOnce({ bsize: 1n, bavail: 100n }).mockResolvedValueOnce({ bsize: 1n, bavail: 99n });
    await expect(createWorktree(root, 'task', f.options)).rejects.toMatchObject({ code: 'VERSE_GIT_REFUSED' });
    expect(f.makeDir).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);
  });
});

describe('workspace restore disk admission', () => {
  it('refuses low capacity before recreating directories or adding a worktree', async () => {
    const f = fixture(99n);
    await expect(restoreWorkspace(workspace, archive, f.options)).rejects.toMatchObject({ code: 'WORKTREE_DISK_REFUSED', status: 409 });
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);
    expect(f.statfs).toHaveBeenCalledWith(dirname(workspace.path), { bigint: true });
  });

  it('refuses unknown capacity before recreating directories or adding a worktree', async () => {
    const f = fixture();
    f.statfs.mockRejectedValue(Object.assign(new Error('unknown disk'), { code: 'EACCES' }));
    await expect(restoreWorkspace(workspace, archive, f.options)).rejects.toMatchObject({ code: 'WORKTREE_DISK_REFUSED' });
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'worktree')).toBe(false);
  });

  it('rechecks capacity after mkdir and keeps a failed restore snapshot intact', async () => {
    const f = fixture();
    f.statfs.mockResolvedValueOnce({ bsize: 1n, bavail: 100n }).mockResolvedValueOnce({ bsize: 1n, bavail: 0n });
    await expect(restoreWorkspace(workspace, archive, f.options)).rejects.toMatchObject({ code: 'WORKTREE_DISK_REFUSED' });
    expect(mocks.mkdir).toHaveBeenCalledTimes(1);
    expect(f.statfs).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls.every(([, args]) => ['cat-file', 'show-ref'].includes(args[0]!))).toBe(true);
  });
});


describe('finished workspace snapshot protection', () => {
  it('retains an existing worktree when HEAD cannot be verified', async () => {
    const f = fixture();
    f.run.mockImplementation(async (_cmd, args) => ({
      code: args[0] === 'rev-parse' ? 128 : 0, stdout: '', stderr: '', timedOut: false,
    }));
    await expect(archiveWorkspace(workspace, 'merged', { ...f.options, probePath: async () => true, deleteBranch: true }))
      .rejects.toMatchObject({ code: 'VERSE_GIT_REFUSED', message: 'The workspace snapshot could not be verified. The workspace was retained.' });
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'worktree' || args[0] === 'branch')).toBe(false);
  });

  it('retains the worktree and branch if pinning the snapshot fails', async () => {
    const f = fixture();
    f.run.mockImplementation(async (_cmd, args) => ({
      code: args[0] === 'update-ref' ? 1 : 0, stdout: 'a'.repeat(40), stderr: '', timedOut: false,
    }));
    await expect(archiveWorkspace(workspace, 'merged', { ...f.options, probePath: async () => true, deleteBranch: true }))
      .rejects.toMatchObject({ code: 'VERSE_GIT_FAILED', message: 'Pinning the snapshot failed.' });
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(true);
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'worktree' || args[0] === 'branch')).toBe(false);
  });
});


describe('agent dependency reuse wiring', () => {
  it.each([0, 1, 128])('creation clones only gitignored dependencies (check-ignore exit %s)', async (ignoreCode) => {
    const f = fixture();
    f.run.mockImplementation(async (_cmd, args) => ({
      code: args[0] === 'check-ignore' ? ignoreCode : args[0] === 'show-ref' ? 1 : 0,
      stdout: args[0] === 'for-each-ref' ? '' : 'a'.repeat(40), stderr: '', timedOut: false,
    }));
    const result = await createAgentWorkspace(root, 'task', [], f.options);
    expect(result.workspace.path).toBe(join(worktreesHome(), 'repository', 'task'));
    expect(f.statfs).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledWith('git', ['check-ignore', '-q', '--', 'node_modules/'], { cwd: result.workspace.path });
    if (ignoreCode === 0) {
      expect(mocks.reuse).toHaveBeenCalledExactlyOnceWith(root, result.workspace.path, f.options.disk);
      const add = f.run.mock.calls.findIndex(([, args]) => args[0] === 'worktree');
      expect(f.run.mock.invocationCallOrder[add]).toBeLessThan(mocks.reuse.mock.invocationCallOrder[0]!);
    } else expect(mocks.reuse).not.toHaveBeenCalled();
  });

  it.each([0, 1, 128])('restore clones only gitignored dependencies (check-ignore exit %s)', async (ignoreCode) => {
    const f = fixture();
    f.run.mockImplementation(async (_cmd, args) => ({
      code: args[0] === 'check-ignore' ? ignoreCode : args[0] === 'show-ref' ? 1 : 0,
      stdout: 'a'.repeat(40), stderr: '', timedOut: false,
    }));
    await expect(restoreWorkspace(workspace, archive, f.options)).resolves.toBeUndefined();
    expect(f.statfs).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledWith('git', ['check-ignore', '-q', '--', 'node_modules/'], { cwd: workspace.path });
    if (ignoreCode === 0) {
      expect(mocks.reuse).toHaveBeenCalledExactlyOnceWith(root, workspace.path, f.options.disk);
      const add = f.run.mock.calls.findIndex(([, args]) => args[0] === 'worktree');
      expect(f.run.mock.invocationCallOrder[add]).toBeLessThan(mocks.reuse.mock.invocationCallOrder[0]!);
    } else expect(mocks.reuse).not.toHaveBeenCalled();
  });
});


describe('unknown workspace filesystem state', () => {
  it('retains the worktree when existence cannot be determined', async () => {
    const f = fixture();
    mocks.access.mockRejectedValueOnce(Object.assign(new Error('private path'), { code: 'EACCES' }));
    await expect(archiveWorkspace(workspace, 'merged', { runner: f.options.runner, deleteBranch: true }))
      .rejects.toThrow('could not be inspected');
    expect(f.run).not.toHaveBeenCalled();
  });
});
