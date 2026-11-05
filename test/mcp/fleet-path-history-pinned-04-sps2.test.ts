import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseFleetPathHistoryArgs, readFleetPathHistory } from '../../src/mcp/fleet-path-history.js';

describe('pinned fleet path history', () => {
  it('resolves once and scans the captured commit even when the ref moves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinned-history-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(dir, 'literal [x].txt'), 'old');
      git('add', '--', 'literal [x].txt');
      git('commit', '-qm', 'bridge(RQ-OLD): old');
      const old = git('rev-parse', 'HEAD').trim();
      git('update-ref', 'refs/remotes/origin/master', old);
      writeFileSync(join(dir, 'literal [x].txt'), 'new');
      writeFileSync(join(dir, 'literal x.txt'), 'decoy');
      git('add', '-A');
      git('commit', '-qm', 'bridge(RQ-NEW): new');
      const newer = git('rev-parse', 'HEAD').trim();
      const calls: string[][] = [];
      const reader = async (args: string[]) => {
        calls.push(args);
        if (calls.length === 2) git('update-ref', 'refs/remotes/origin/master', newer);
        return git(...args);
      };
      const result = await readFleetPathHistory({ path: 'literal [x].txt', limit: 2 }, { git: reader });
      expect(calls).toEqual([
        ['rev-parse', '--verify', 'origin/master^{commit}'],
        ['--literal-pathspecs', 'log', '-n6', '--format=%H%x09%cI%x09%s', old, '--', 'literal [x].txt'],
      ]);
      expect(result).toMatchObject({ ref: 'origin/master', resolvedRef: old, jobs: [{ jobId: 'RQ-OLD', sha: old }] });
      const absent = await readFleetPathHistory({ path: 'missing', limit: 1 }, { git: async args => git(...args) });
      expect(absent).toMatchObject({ resolvedRef: newer, scanned: 0, jobs: [] });
      expect(absent.note).toContain('does not prove');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('passes explicit validated evidence to an injected log, and leaves legacy evidence null', async () => {
    const oid = 'a'.repeat(40);
    const resolve = vi.fn(async () => oid);
    const log = vi.fn(async () => []);
    expect((await readFleetPathHistory({ path: 'x', limit: 1 }, { resolve, log })).resolvedRef).toBe(oid);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('x', 3, oid);
    log.mockClear();
    expect((await readFleetPathHistory({ path: 'x', limit: 1 }, { log })).resolvedRef).toBeNull();
    expect(log).toHaveBeenCalledWith('x', 3);
  });

  it('propagates malformed resolution, resolver errors, and log errors', async () => {
    const log = vi.fn(async () => []);
    await expect(readFleetPathHistory({ path: 'x', limit: 1 }, { resolve: async () => 'abc', log })).rejects.toThrow('Invalid resolved commit OID');
    expect(log).not.toHaveBeenCalled();
    await expect(readFleetPathHistory({ path: 'x', limit: 1 }, { git: async () => { throw new Error('resolve failed'); } })).rejects.toThrow('resolve failed');
    await expect(readFleetPathHistory({ path: 'x', limit: 1 }, { resolve: async () => 'a'.repeat(40), log: async () => { throw new Error('log failed'); } })).rejects.toThrow('log failed');
  });

  it('rejects invalid inputs before invoking readers', async () => {
    const log = vi.fn(async () => []);
    const resolve = vi.fn(async () => 'a'.repeat(40));
    for (const args of [{ path: '../x' }, { path: 'x', ref: 'HEAD' }, { path: 'x', limit: 0 }]) {
      const parsed = parseFleetPathHistoryArgs(args);
      if (parsed) await readFleetPathHistory(parsed, { log, resolve });
      expect(parsed).toBeNull();
    }
    expect(log).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
