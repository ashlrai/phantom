import { describe, expect, it, vi } from 'vitest';
import * as history from '../src/core/fleet/job-path-history.js';
import { jobPathHistory, JOB_SCAN_BOUND } from '../src/core/fleet/job-path-history.js';
import { cmdFleetPathHistory } from '../src/cli/fleet-path-history.js';

vi.mock('../src/core/fleet/job-path-history.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/job-path-history.js')>();
  return { ...actual, jobPathHistory: vi.fn(actual.jobPathHistory) };
});

const sha = (n: number) => n.toString(16).padStart(40, '0');

describe('older job history', () => {
  it('continues at the first parent of the boundary on the pinned traversal', async () => {
    let head = 1002;
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return `${sha(head)}\n`;
      if (args[0] === 'rev-list') return `${args[4]} ${sha(2)} ${sha(9999)}\n`;
      if (args[0] === 'diff-tree') return 'landed.txt\0';
      if (args[0] === 'log') {
        const start = parseInt(args[4]!, 16);
        return Array.from({ length: Math.min(start, JOB_SCAN_BOUND) }, (_, i) => {
          const n = start - i;
          return `${sha(n)}\0date\0${n === 2 ? 'bridge(RQ-OLD): landed (#42)' : 'ordinary'}\0\n`;
        }).join('');
      }
      throw new Error('unexpected git command');
    };
    const first = await jobPathHistory('RQ-OLD', 'HEAD', 20, run);
    expect(first.resolvedRef).toBe(sha(1002));
    expect(first.nextBefore).toBe(sha(2));
    expect(first.scanMayBeTruncated).toBe(true);
    expect(first.commits).toEqual([]);
    head = 2000;
    const second = await jobPathHistory('RQ-OLD', first.resolvedRef, 20, async args => {
      if (args[0] === 'rev-parse') return first.resolvedRef;
      return run(args);
    }, { before: first.nextBefore! });
    expect(second.commits.map(c => c.sha)).toEqual([sha(2)]);
    expect(second.nextBefore).toBeNull();
    expect(calls.filter(c => c[0] === 'log').map(c => c.slice(1, 5))).toEqual([
      ['-n1000', '--first-parent', '--format=%H%x00%cI%x00%s%x00', sha(1002)],
      ['-n1000', '--first-parent', '--format=%H%x00%cI%x00%s%x00', sha(2)],
    ]);
    expect(calls.find(c => c[0] === 'rev-list')?.slice(0, 4)).toEqual(['rev-list', '--parents', '-n', '1']);
  });

  it('has no continuation when the 1000th commit is a root', async () => {
    const run = async (args: string[]) => {
      if (args[0] === 'rev-parse') return sha(1000);
      if (args[0] === 'rev-list') return sha(1);
      if (args[0] === 'log') return Array.from({ length: 1000 }, (_, i) => `${sha(1000 - i)}\0date\0ordinary\0\n`).join('');
      throw new Error('unexpected command');
    };
    const result = await jobPathHistory('RQ-OLD', 'HEAD', 20, run);
    expect(result.nextBefore).toBeNull();
    expect(result.scanMayBeTruncated).toBe(false);
  });

  it('rejects malformed cursors before invoking git', async () => {
    const run = vi.fn(async () => '');
    for (const before of ['abc', 'a'.repeat(41), '-'.repeat(40)]) {
      await expect(jobPathHistory('RQ-OLD', 'HEAD', 20, run, { before })).rejects.toThrow('invalid job history arguments');
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('passes a valid cursor to job mode and prints the continuation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mock = vi.mocked(history.jobPathHistory);
    mock.mockResolvedValueOnce({ jobId: 'RQ-OLD', ref: 'HEAD', resolvedRef: sha(1002), nextBefore: sha(2), scanBound: 1000, scanned: 1000, scanMayBeTruncated: true, limit: 20, matchesTruncated: false, commits: [], paths: [] });
    try {
      expect(await cmdFleetPathHistory(['--job', 'RQ-OLD', '--ref', 'HEAD', '--before', sha(3)])).toBe(0);
      expect(mock).toHaveBeenCalledWith('RQ-OLD', 'HEAD', 20, undefined, { before: sha(3) });
      expect(log.mock.calls.flat().join(' ')).toContain(`--ref ${sha(1002)} --before ${sha(2)}`);
      expect(log.mock.calls.flat().join(' ')).toContain('does not prove');
    } finally { log.mockRestore(); }
  });

  it('rejects cursors in path mode and malformed job cursors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdFleetPathHistory(['file', '--before', sha(1)])).toBe(2);
      expect(await cmdFleetPathHistory(['--job', 'RQ-OLD', '--before', 'abc'])).toBe(2);
      expect(await cmdFleetPathHistory(['--job', 'RQ-OLD', '--before', sha(1), '--before', sha(2)])).toBe(2);
    } finally { error.mockRestore(); }
  });
});
