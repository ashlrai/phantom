import { beforeEach, describe, expect, it, vi } from 'vitest';

const { statfsMock, execFileMock } = vi.hoisted(() => ({
  statfsMock: vi.fn(),
  execFileMock: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ statfs: statfsMock }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
import { measureDisk } from '../src/core/fabric/disk-signal.js';

beforeEach(() => {
  vi.resetAllMocks();
  statfsMock.mockResolvedValue({ bavail: 42, bsize: 4096 });
  execFileMock.mockImplementation((_command, _args, _opts, callback) => callback(null, '12\t/worktrees\n', ''));
});

describe('disk measurements', () => {
  it('measures available blocks and allocated worktree space', async () => {
    expect(await measureDisk('/data', '/worktrees')).toEqual({ freeBytes: 172032, worktreeBytes: 12288 });
    expect(statfsMock).toHaveBeenCalledWith('/data');
    expect(execFileMock).toHaveBeenCalledWith('du', ['-sk', '--', '/worktrees'], expect.objectContaining({ timeout: 5000 }), expect.any(Function));
  });

  it('keeps failed and malformed measurements unknown', async () => {
    statfsMock.mockRejectedValue(new Error('unavailable'));
    execFileMock.mockImplementation((_command, _args, _opts, callback) => callback(null, 'bad output', ''));
    expect(await measureDisk('/data', '/worktrees')).toEqual({ freeBytes: null, worktreeBytes: null });
  });
});
