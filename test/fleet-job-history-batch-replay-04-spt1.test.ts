import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobHistoryBatch } from '../src/cli/fleet-job-history-batch.js';
import { jobHistoryBatch } from '../src/core/fleet/job-history-batch.js';

it('replays an earlier master snapshot and rejects invalid or unrelated objects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-replay-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (file: string, subject: string) => {
    writeFileSync(join(dir, file), file);
    git('add', file); git('commit', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    commit('one', 'bridge(RQ-AAA-1): first (#1)');
    commit('other', 'bridge(RQ-AAA-1-EXTRA): lookalike (#2)');
    const old = commit('two', 'bridge(RQ-AAA-1): second (#3)');
    git('update-ref', 'refs/remotes/origin/master', old);
    process.chdir(dir);
    const args = ['RQ-AAA-1', '--limit', '1', '--json'];
    expect(await cmdFleetJobHistoryBatch(args)).toBe(0);
    const saved = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(saved.jobs[0]).toMatchObject({ matchesTruncated: true, paths: ['two'] });
    const latest = commit('three', 'bridge(RQ-AAA-1): third (#4)');
    git('update-ref', 'refs/remotes/origin/master', latest);
    expect(await cmdFleetJobHistoryBatch([...args, '--at', old])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual(saved);
    expect(await cmdFleetJobHistoryBatch(args)).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ resolvedRef: latest, jobs: [{ paths: ['three'] }] });
    git('checkout', '--orphan', 'unrelated');
    git('rm', '-rf', '.');
    const unrelated = commit('isolated', 'bridge(RQ-AAA-1): unrelated (#5)');
    const blob = git('rev-parse', `${old}:one`);
    for (const oid of [unrelated, blob, 'f'.repeat(40)]) {
      expect(await cmdFleetJobHistoryBatch([...args, '--at', oid])).toBe(1);
    }
    for (const oid of ['abc', '-bad', 'g'.repeat(40)]) {
      expect(await cmdFleetJobHistoryBatch([...args, '--at', oid])).toBe(2);
    }
    const run = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'rev-parse') return old;
      if (argv[0] === 'log') return '';
      throw new Error('unexpected git call');
    });
    expect((await jobHistoryBatch(['RQ-AAA-1'], 1, run)).resolvedRef).toBe(old);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
});
