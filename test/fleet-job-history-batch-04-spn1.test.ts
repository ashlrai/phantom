import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobHistoryBatch } from '../src/cli/fleet-job-history-batch.js';
import { jobHistoryBatch } from '../src/core/fleet/job-history-batch.js';

const OID = 'e'.repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, '0');
const record = (n: number, subject: string) => `${sha(n)}\0d${n}\0${subject}\0\n`;

it('answers a batch through real git in input order, exact ids only, with resolvedRef', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-history-batch-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'one.txt'), 'a');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-AAA-1): first job (#11)');
    writeFileSync(join(dir, 'plain.txt'), 'p');
    git('add', '.'); git('commit', '-m', 'plain cleanup');
    writeFileSync(join(dir, 'lookalike.txt'), 'x');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-AAA-1-EXTRA): prefix lookalike (#12)');
    writeFileSync(join(dir, 'two.txt'), 'b');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-BBB-2): second job (#13)');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const oid = git('rev-parse', 'HEAD').trim();
    process.chdir(dir);
    expect(await cmdFleetJobHistoryBatch(['RQ-BBB-2', 'RQ-AAA-1', 'RQ-MISSING-9', '--json'])).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out.resolvedRef).toBe(oid);
    expect(out).toMatchObject({ scanBound: 1000, scanned: 4, scanMayBeTruncated: false, limit: 20 });
    expect(out.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-BBB-2', 'RQ-AAA-1', 'RQ-MISSING-9']);
    expect(out.jobs[0]).toMatchObject({ matchesTruncated: false, paths: ['two.txt'] });
    expect(out.jobs[0].commits).toHaveLength(1);
    expect(out.jobs[0].commits[0]).toMatchObject({ pr: 13, paths: ['two.txt'] });
    // Exact id only: RQ-AAA-1 sees one.txt, never the RQ-AAA-1-EXTRA lookalike commit.
    expect(out.jobs[1]).toMatchObject({ matchesTruncated: false, paths: ['one.txt'] });
    expect(out.jobs[1].commits).toHaveLength(1);
    expect(out.jobs[1].commits[0].paths).not.toContain('lookalike.txt');
    expect(out.jobs[2]).toMatchObject({ jobId: 'RQ-MISSING-9', matchesTruncated: false, commits: [], paths: [] });
    // The lookalike is its own exact id.
    expect(await cmdFleetJobHistoryBatch(['RQ-AAA-1-EXTRA', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).jobs[0].paths).toEqual(['lookalike.txt']);
    // Text mode explains empty bounded evidence.
    expect(await cmdFleetJobHistoryBatch(['RQ-MISSING-9'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('does not prove the job never landed');
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('serves twenty ids from one resolved OID and one bounded log scan', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `RQ-JOB-${i}`);
  const history = record(1, 'bridge(RQ-JOB-3): three (#31)')
    + record(2, 'plain commit')
    + record(3, 'bridge(RQ-JOB-17): seventeen (#32)')
    + record(4, 'bridge(RQ-JOB-3): again (#33)');
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') return history;
    if (args[0] === 'diff-tree') return `p/${args.at(-2)!.slice(-6)}.ts\0`;
    throw new Error('unexpected git call');
  });
  const result = await jobHistoryBatch(ids, 20, run);
  expect(run.mock.calls.filter(call => call[0][0] === 'rev-parse')).toEqual([
    [['rev-parse', '--verify', 'origin/master^{commit}']],
  ]);
  // One log scan for all ids, on the immutable OID — never the movable ref.
  expect(run.mock.calls.filter(call => call[0][0] === 'log')).toEqual([
    [['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', OID, '--']],
  ]);
  // diff-tree runs only for the three retained matching commits, by sha.
  expect(run.mock.calls.filter(call => call[0][0] === 'diff-tree')).toHaveLength(3);
  expect(run).toHaveBeenCalledWith(['diff-tree', '--root', '-m', '--first-parent', '--no-commit-id',
    '--name-only', '--no-renames', '-r', '-z', sha(4), '--']);
  expect(result).toMatchObject({ resolvedRef: OID, scanBound: 1000, scanned: 4, scanMayBeTruncated: false });
  expect(result.jobs.map(job => job.jobId)).toEqual(ids);
  expect(result.jobs[3].commits.map(commit => commit.sha)).toEqual([sha(1), sha(4)]);
  expect(result.jobs[3].paths).toEqual([`p/${sha(1).slice(-6)}.ts`, `p/${sha(4).slice(-6)}.ts`]);
  expect(result.jobs[17].commits).toHaveLength(1);
  expect(result.jobs[17].matchesTruncated).toBe(false);
  expect(result.jobs[0]).toMatchObject({ jobId: 'RQ-JOB-0', commits: [], paths: [], matchesTruncated: false });
});

it('reports per-id limit truncation and scan-bound truncation honestly', async () => {
  const three = record(1, 'bridge(RQ-JOB-3): a') + record(2, 'plain') + record(3, 'bridge(RQ-JOB-3): b');
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return `${OID}\n`;
    if (args[0] === 'log') return three;
    return 'p\0';
  });
  const limited = await jobHistoryBatch(['RQ-JOB-3'], 1, run);
  expect(limited.jobs[0].commits.map(commit => commit.sha)).toEqual([sha(1)]);
  expect(limited.jobs[0].matchesTruncated).toBe(true);
  // The second matching commit counted toward truncation but cost no diff-tree call.
  expect(run.mock.calls.filter(call => call[0][0] === 'diff-tree')).toHaveLength(1);
  const full = Array.from({ length: 1000 }, (_, i) => record(i + 10, 'bridge(RQ-JOB-3): x')).join('');
  run.mockImplementation(async (args: string[]) => args[0] === 'rev-parse' ? `${OID}\n` : args[0] === 'log' ? full : 'p\0');
  const bound = await jobHistoryBatch(['RQ-JOB-3'], 20, run);
  expect(bound).toMatchObject({ scanned: 1000, scanMayBeTruncated: true });
  expect(bound.jobs[0]).toMatchObject({ matchesTruncated: true });
  expect(bound.jobs[0].commits).toHaveLength(20);
});

it('validates ids and limit before invoking git, and propagates git failure', async () => {
  const run = vi.fn(async () => 'x');
  for (const [ids, limit] of [
    [[], 20],
    [Array.from({ length: 21 }, (_, i) => `RQ-${i}`), 20],
    [['RQ-A', 'RQ-A'], 20],
    [['nope'], 20], [['RQ-'], 20], [['RQ-A B'], 20],
    [['RQ-A'], 0], [['RQ-A'], 101], [['RQ-A'], 1.5], [['RQ-A'], '20'],
  ] as Array<[string[], number]>) {
    await expect(jobHistoryBatch(ids, limit, run)).rejects.toThrow('invalid job history batch arguments');
  }
  expect(run).not.toHaveBeenCalled();
  run.mockResolvedValue('not-an-oid\n');
  await expect(jobHistoryBatch(['RQ-A'], 20, run)).rejects.toThrow('unable to resolve');
  run.mockRejectedValue(new Error('fatal: not a git repository'));
  await expect(jobHistoryBatch(['RQ-A'], 20, run)).rejects.toThrow('not a git repository');
});

it('rejects invalid arguments and reports git failure without fabricating evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-history-batch-nogit-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // Not a git repository: a 2 proves rejection happened before any git call (which would exit 1).
    process.chdir(dir);
    for (const args of [
      [] as string[], ['RQ-A', 'RQ-A'], ['nope'], ['rq-a'], ['RQ-'], ['--json'], ['--limit', '5'],
      ['RQ-A', '--limit', '0'], ['RQ-A', '--limit', '101'], ['RQ-A', '--limit', 'x'], ['RQ-A', '--limit'],
      ['RQ-A', '--bogus'], ['RQ-A', '--ref', 'HEAD'], ['RQ-A', '--job', 'RQ-B'], ['RQ-A', '--json', '--json'],
      Array.from({ length: 21 }, (_, i) => `RQ-${i}`),
    ]) {
      expect(await cmdFleetJobHistoryBatch(args)).toBe(2);
    }
    expect(await cmdFleetJobHistoryBatch(['--help'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('Usage: ashlr fleet job-history-batch');
    expect(await cmdFleetJobHistoryBatch(['RQ-A'])).toBe(1);
    expect(error.mock.calls.at(-1)![0]).toContain('unable to read job history batch from git');
    expect(log.mock.calls.some(call => String(call[0]).includes('"commits"'))).toBe(false);
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
