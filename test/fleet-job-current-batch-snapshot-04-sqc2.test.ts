import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobCurrentBatchSnapshot } from '../src/cli/fleet-job-current-batch-snapshot.js';
import { jobCurrentBatchSnapshot } from '../src/core/fleet/job-current-batch-snapshot.js';
import { JOB_BATCH_MAX } from '../src/core/fleet/job-history-batch.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'batch-replay-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path: string, text: string) => writeFileSync(join(dir, path), text);
  const commit = (subject: string) => { git('add', '-A'); git('commit', '-qm', subject); };
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  write('deleted', 'old'); commit('base');
  write('first', 'one'); commit('bridge(RQ-ONE): first (#1)');
  rmSync(join(dir, 'deleted')); write('second', 'two'); commit('bridge(RQ-TWO): second (#2)');
  const snapshot = git('rev-parse', 'HEAD').trim();
  write('first', 'changed'); rmSync(join(dir, 'second')); commit('advance');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  const run = async (args: string[]) => git(...args);
  return { dir, git, run, snapshot };
}

it('replays all jobs at one snapshot with a shared bounded scan after master advances', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    const report = await jobCurrentBatchSnapshot(f.snapshot, ['RQ-ONE', 'RQ-TWO', 'RQ-MISSING'], async args => { calls.push(args); return f.run(args); });
    expect(report).toMatchObject({ requestedSnapshot: f.snapshot, resolvedRef: f.snapshot, totals: { jobs: 3, matched: 2, unchanged: 2, absentAtBoth: 1 } });
    expect(report.jobs.every(job => job.resolvedRef === f.snapshot)).toBe(true);
    expect(report.jobs[0]!.entries).toEqual([expect.objectContaining({ path: 'first', status: 'unchanged' })]);
    expect(report.jobs[1]!.entries).toContainEqual(expect.objectContaining({ path: 'deleted', status: 'absent-at-both' }));
    expect(report.jobs[2]!.commit).toBeNull();
    expect(report.caveat).toContain('not current origin/master');
    expect(calls.filter(args => args[0] === 'log')).toEqual([['log', '-n1000', '--first-parent', '--format=%H%x00%cI%x00%s%x00', f.snapshot, '--']]);
    expect(calls.filter(args => args.some(arg => arg.includes('origin/master')))).toEqual([['merge-base', '--is-ancestor', f.snapshot, 'origin/master']]);
    expect(calls.every(args => ['cat-file', 'merge-base', 'log', 'diff-tree', 'ls-tree'].includes(args[0]!))).toBe(true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it('rejects invalid inputs before reads and rejects non-commit and non-ancestor objects', async () => {
  const run = vi.fn(async () => 'commit');
  const oid = 'a'.repeat(40);
  for (const [snapshot, ids] of [['A'.repeat(40), ['RQ-A']], [oid, []], [oid, ['RQ-A', 'RQ-A']], [oid, ['bad']], [oid, Array.from({ length: JOB_BATCH_MAX + 1 }, (_, i) => `RQ-${i}`)]] as Array<[string, string[]]>) {
    await expect(jobCurrentBatchSnapshot(snapshot, ids, run)).rejects.toThrow('invalid');
  }
  expect(run).not.toHaveBeenCalled();
  const f = fixture();
  try {
    const blob = f.git('hash-object', '-w', '--stdin'); // empty blob in this temporary repository
    await expect(jobCurrentBatchSnapshot(blob.trim(), ['RQ-A'], f.run)).rejects.toThrow('not a commit');
    f.git('checkout', '-qb', 'side', f.snapshot);
    writeFileSync(join(f.dir, 'side'), 'side'); f.git('add', 'side'); f.git('commit', '-qm', 'side');
    await expect(jobCurrentBatchSnapshot(f.git('rev-parse', 'HEAD').trim(), ['RQ-A'], f.run)).rejects.toThrow('not an ancestor');
    await expect(jobCurrentBatchSnapshot(oid, ['RQ-A'], async () => { throw new Error('fake git failure'); })).rejects.toThrow('fake git failure');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it('validates CLI input before reads, outputs sanitized evidence, and hides git failures', async () => {
  const f = fixture(), cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.chdir(tmpdir());
    for (const args of [[], ['--at'], ['RQ-A'], ['--at', f.snapshot], ['--at', f.snapshot, 'RQ-A', 'RQ-A'], ['--at', f.snapshot, '--at', f.snapshot, 'RQ-A'], ['--at', f.snapshot, 'RQ-A', '--json', '--json'], ['--at', f.snapshot, 'RQ-A', '--bad'], ['--at', f.snapshot, ...Array.from({ length: JOB_BATCH_MAX + 1 }, (_, i) => `RQ-${i}`)]]) {
      expect(await cmdFleetJobCurrentBatchSnapshot(args)).toBe(2);
    }
    expect(await cmdFleetJobCurrentBatchSnapshot(['--at', f.snapshot, 'RQ-A'])).toBe(1);
    expect(error.mock.calls.at(-1)![0]).toBe('error: unable to replay job current batch snapshot from git');
    process.chdir(f.dir);
    expect(await cmdFleetJobCurrentBatchSnapshot(['--at', f.snapshot, 'RQ-ONE', 'RQ-MISSING', '--json'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(result).toMatchObject({ requestedSnapshot: f.snapshot, totals: { jobs: 2, matched: 1 } });
    expect(result.jobs[1].commit).toBeNull();
    expect(await cmdFleetJobCurrentBatchSnapshot(['--at', f.snapshot, 'RQ-TWO', 'RQ-MISSING'])).toBe(0);
    const output = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('absent-at-both'); expect(output).toContain('does not prove the job never landed');
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(f.dir, { recursive: true, force: true }); }
});
