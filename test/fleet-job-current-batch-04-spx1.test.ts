import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobCurrentBatch } from '../src/cli/fleet-job-current-batch.js';
import { jobCurrent } from '../src/core/fleet/job-current.js';
import { jobCurrentBatch } from '../src/core/fleet/job-current-batch.js';

const execAsync = promisify(execFile);

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'job-current-batch-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const commit = (subject: string) => { git('add', '-A'); git('commit', '-qm', subject); };
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  write('base.txt', 'base'); commit('plain base');
  write('keep.txt', 'keep'); write('edit.txt', 'v1'); write('gone.txt', 'bye');
  write('dir with spaces/f [x].txt', 's'); write('glob[?].txt', 'g');
  commit('bridge(RQ-BAT-1): first job secret words (#7)');
  const sha1 = git('rev-parse', 'HEAD').trim();
  write('two.txt', 'two'); commit('bridge(RQ-BAT-2): second job (#8)');
  const sha2 = git('rev-parse', 'HEAD').trim();
  write('edit.txt', 'v2'); rmSync(join(dir, 'gone.txt')); commit('plain later work');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  const run = async (args: string[]) => (await execAsync('git', args,
    { cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  return { dir, git, run, write, commit, sha1, sha2, oid: git('rev-parse', 'HEAD').trim() };
}

it('audits a real batch equal to per-id jobCurrent on the pinned commit, absent ids included', async () => {
  const repo = makeRepo();
  try {
    const batch = await jobCurrentBatch(['RQ-BAT-1', 'RQ-BAT-2', 'RQ-NOPE-9'], repo.run);
    expect(batch).toMatchObject({ schemaVersion: 1, ref: 'origin/master', resolvedRef: repo.oid,
      scanBound: 1000, scanned: 4, scanMayBeTruncated: false });
    expect(batch.jobs.map(job => job.jobId)).toEqual(['RQ-BAT-1', 'RQ-BAT-2', 'RQ-NOPE-9']);
    for (const report of batch.jobs) expect(report).toEqual(await jobCurrent(report.jobId, repo.run));
    const first = new Map(batch.jobs[0]!.entries.map(entry => [entry.path, entry.status]));
    expect(first.get('keep.txt')).toBe('unchanged');
    expect(first.get('edit.txt')).toBe('changed');
    expect(first.get('gone.txt')).toBe('absent-now');
    // Literal pathspecs: spaces, brackets and glob characters never expand.
    expect(first.get('dir with spaces/f [x].txt')).toBe('unchanged');
    expect(first.get('glob[?].txt')).toBe('unchanged');
    expect(batch.jobs[0]!.commit).toMatchObject({ sha: repo.sha1, pr: 7 });
    expect(batch.jobs[1]!.commit).toMatchObject({ sha: repo.sha2, pr: 8 });
    expect(batch.jobs[1]!.entries).toEqual([expect.objectContaining({ path: 'two.txt', status: 'unchanged' })]);
    expect(batch.jobs[2]!).toMatchObject({ commit: null, entries: [], omittedPaths: 0 });
    expect(batch.totals).toEqual({ jobs: 3, matched: 2, unchanged: 4, changed: 1, absentNow: 1, absentAtBoth: 0, omittedPaths: 0 });
    expect(JSON.stringify(batch)).not.toContain('secret words');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('keeps every report on the original OID with one shared log scan while origin/master moves', async () => {
  const repo = makeRepo();
  try {
    repo.write('keep.txt', 'moved'); repo.commit('plain moved head');
    const movedOid = repo.git('rev-parse', 'HEAD').trim();
    const calls: string[][] = [];
    let moved = false;
    const run = async (args: string[]) => {
      calls.push(args);
      const out = await repo.run(args);
      if (!moved && args[0] === 'diff-tree') { moved = true; repo.git('update-ref', 'refs/remotes/origin/master', movedOid); }
      return out;
    };
    const batch = await jobCurrentBatch(['RQ-BAT-1', 'RQ-BAT-2'], run);
    expect(moved).toBe(true);
    expect(batch.resolvedRef).toBe(repo.oid);
    for (const report of batch.jobs) expect(report.resolvedRef).toBe(repo.oid);
    // Identical to jobCurrent pinned to the same commit even after the ref moved.
    const pinned = async (args: string[]) => args[0] === 'rev-parse' ? `${repo.oid}\n` : repo.run(args);
    for (const report of batch.jobs) expect(report).toEqual(await jobCurrent(report.jobId, pinned));
    // keep.txt compares against the pinned tree, not the moved head that rewrote it.
    expect(batch.jobs[0]!.entries.find(entry => entry.path === 'keep.txt')!.status).toBe('unchanged');
    // One ref resolution and one shared bounded log scan, both on the immutable OID.
    expect(calls.filter(call => call[0] === 'rev-parse')).toEqual([['rev-parse', '--verify', 'origin/master^{commit}']]);
    expect(calls.filter(call => call[0] === 'log')).toEqual([
      ['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', repo.oid, '--']]);
    // Read-only verbs only; never a fetch or mutation.
    expect(new Set(calls.map(call => call[0]))).toEqual(new Set(['rev-parse', 'log', 'diff-tree', 'ls-tree']));
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('validates ids before any git call and propagates reader failure', async () => {
  const run = vi.fn(async () => 'x');
  for (const ids of [
    'RQ-A', [], Array.from({ length: 21 }, (_, i) => `RQ-${i}`),
    ['RQ-A', 'RQ-A'], ['nope'], ['rq-a'], ['RQ-'], ['RQ-A B'], ['RQ-A', 7], [null],
  ] as unknown[]) {
    await expect(jobCurrentBatch(ids as string[], run)).rejects.toThrow('invalid job current batch arguments');
  }
  expect(run).not.toHaveBeenCalled();
  run.mockResolvedValue('not-an-oid\n');
  await expect(jobCurrentBatch(['RQ-A'], run)).rejects.toThrow('unable to resolve');
  run.mockRejectedValue(new Error('fatal: not a git repository'));
  await expect(jobCurrentBatch(['RQ-A'], run)).rejects.toThrow('not a git repository');
});

it('serves the CLI: help, strict validation, JSON shape and a scrubbed git failure', async () => {
  const repo = makeRepo();
  const nogit = mkdtempSync(join(tmpdir(), 'job-current-batch-nogit-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.chdir(nogit); // a 2 here proves rejection happened before any git call, which would exit 1
    for (const args of [
      [] as string[], ['nope'], ['rq-bat-1'], ['RQ-'], ['RQ-A B'], ['--json'], ['--limit', '5'],
      ['RQ-A', 'RQ-A'], ['RQ-A', '--bogus'], ['RQ-A', '--json', '--json'], ['RQ-A', '--help'],
      Array.from({ length: 21 }, (_, i) => `RQ-${i}`),
    ]) {
      expect(await cmdFleetJobCurrentBatch(args)).toBe(2);
    }
    for (const flag of ['--help', '-h']) {
      expect(await cmdFleetJobCurrentBatch([flag])).toBe(0);
      expect(log.mock.calls.at(-1)![0]).toContain('Usage: ashlr fleet job-current-batch');
    }
    process.chdir(repo.dir);
    expect(await cmdFleetJobCurrentBatch(['RQ-BAT-1', 'RQ-NOPE-9', '--json'])).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out).toMatchObject({ schemaVersion: 1, ref: 'origin/master', resolvedRef: repo.oid, scanned: 4 });
    expect(out.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-BAT-1', 'RQ-NOPE-9']);
    expect(out.jobs[0].entries).toHaveLength(5);
    expect(out.jobs[0].commit).toMatchObject({ sha: repo.sha1, pr: 7 });
    expect(out.jobs[1].commit).toBeNull();
    expect(out.totals).toMatchObject({ jobs: 2, matched: 1, changed: 1, absentNow: 1 });
    expect(JSON.stringify(out)).not.toContain('secret words');
    const before = log.mock.calls.length;
    expect(await cmdFleetJobCurrentBatch(['RQ-BAT-1', 'RQ-NOPE-9'])).toBe(0);
    const lines = log.mock.calls.slice(before).map(call => String(call[0]));
    expect(lines.some(line => line.includes('changed') && line.includes('edit.txt'))).toBe(true);
    expect(lines.some(line => line.includes('absent-now') && line.includes('gone.txt'))).toBe(true);
    expect(lines.some(line => line.includes('RQ-NOPE-9') && line.includes('does not prove the job never landed'))).toBe(true);
    expect(lines.at(-1)).toContain('2 jobs (1 with a bridge commit)');
    expect(lines.at(-1)).toContain('evidence only');
    process.chdir(nogit);
    const callsBeforeFailure = log.mock.calls.length;
    expect(await cmdFleetJobCurrentBatch(['RQ-BAT-1'])).toBe(1);
    expect(error.mock.calls.at(-1)![0]).toContain('unable to read job current batch from git');
    expect(log.mock.calls.slice(callsBeforeFailure)).toEqual([]);
  } finally {
    process.chdir(cwd); log.mockRestore(); error.mockRestore();
    rmSync(repo.dir, { recursive: true, force: true }); rmSync(nogit, { recursive: true, force: true });
  }
});
