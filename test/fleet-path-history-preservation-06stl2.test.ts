import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetPathHistory } from '../src/cli/fleet-path-history.js';

it('keeps job snapshot, cursor validation and first-parent scanning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-preserve-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(dir, 'file'), 'first'); git('add', '.'); git('commit', '-m', 'bridge(RQ-PAGE): first (#1)');
    const first = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'side');
    writeFileSync(join(dir, 'side'), 'side'); git('add', '.'); git('commit', '-m', 'bridge(RQ-PAGE): side (#2)');
    git('checkout', 'main');
    writeFileSync(join(dir, 'file'), 'second'); git('commit', '-am', 'bridge(RQ-PAGE): second (#3)');
    git('merge', '--no-ff', 'side', '-m', 'merge side');
    const head = git('rev-parse', 'HEAD');
    process.chdir(dir);
    expect(await cmdFleetPathHistory(['--job', 'RQ-PAGE', '--ref', 'HEAD', '--json'])).toBe(0);
    const result = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(result).toMatchObject({ resolvedRef: head, nextBefore: null, scanned: 3, paths: ['file'] });
    expect(result.commits.map((c: { pr: number }) => c.pr)).toEqual([3, 1]);
    expect(await cmdFleetPathHistory(['--job', 'RQ-PAGE', '--ref', head, '--before', first, '--json'])).toBe(0);
    const earlier = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(earlier.resolvedRef).toBe(head);
    expect(earlier.commits.map((c: { pr: number }) => c.pr)).toEqual([1]);
    expect(await cmdFleetPathHistory(['--job', 'RQ-PAGE', '--before', 'abc'])).toBe(2);
    expect(await cmdFleetPathHistory(['file', '--before', first])).toBe(2);
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('preserves injected log, bulk exclusion, counts and JSON shape', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const adapter = vi.fn(async () => [
    { sha: 'a', date: '2026-01-01', subject: 'bridge(RQ-BULK): bulk (#1)', filesChanged: 500 },
    { sha: 'b', date: '2026-01-02', subject: 'bridge(RQ-KEEP): keep (#2)', filesChanged: 1 },
  ]);
  try {
    expect(await cmdFleetPathHistory(['file', '--json'], { log: adapter })).toBe(0);
    expect(adapter).toHaveBeenCalledWith('file', 20);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual([{ jobId: 'RQ-KEEP', pr: 2, sha: 'b', date: '2026-01-02', title: 'keep' }]);
    expect(await cmdFleetPathHistory(['file'], { log: adapter })).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('skipped 1 bulk commit (>=500 files)');
  } finally { log.mockRestore(); }
});
