import { describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => callback(null, '{}', '')));
vi.mock('node:child_process', () => ({ execFile }));
import { readGitHub } from '../src/core/merge-path.js';

describe('merge path GitHub transport', () => {
  it('uses only gh api GET arguments and rejects arbitrary flags', async () => {
    await readGitHub('repos/acme/repo/rules/branches/main?per_page=100&page=1');
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0]?.slice(0, 2)).toEqual(['gh', ['api', 'repos/acme/repo/rules/branches/main?per_page=100&page=1']]);
    expect(() => readGitHub('--method=POST')).toThrow('Invalid GitHub API path');
    expect(execFile).toHaveBeenCalledOnce();
  });
});
