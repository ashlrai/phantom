import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobCompare } from '../src/cli/fleet-job-compare.js';
import { jobCompare, type JobCompareReader } from '../src/core/fleet/job-compare.js';
import type { JobCurrentBatchReport } from '../src/core/fleet/job-current-batch.js';
import { jobCurrentBatch } from '../src/core/fleet/job-current-batch.js';
import type { JobCurrentReport, JobCurrentEntry } from '../src/core/fleet/job-current.js';

const execAsync = promisify(execFile);

/**
 * base has gone.txt. Job 1 (#7) deletes gone.txt, writes shared.txt 'one' and
 * same.txt 'same'. A plain commit restores gone.txt and changes same.txt, so
 * job 2 (#8) must touch same.txt again: it deletes gone.txt, writes shared.txt
 * 'two' and sets same.txt back to the identical 'same' blob. At the landed
 * commits shared.txt is different, same.txt identical and gone.txt both-absent.
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'job-compare-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const commit = (subject: string) => { git('add', '-A'); git('commit', '-qm', subject); };
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  write('gone.txt', 'bye'); commit('plain base');
  git('rm', '-q', 'gone.txt'); write('shared.txt', 'one'); write('same.txt', 'same'); write('only-a.txt', 'a');
  commit('bridge(RQ-CMP-1): first job secret words (#7)');
  const sha1 = git('rev-parse', 'HEAD').trim();
  write('gone.txt', 'again'); write('same.txt', 'other'); commit('plain restore');
  git('rm', '-q', 'gone.txt'); write('shared.txt', 'two'); write('same.txt', 'same'); write('only-b.txt', 'b');
  commit('bridge(RQ-CMP-2): second job (#8)');
  const sha2 = git('rev-parse', 'HEAD').trim();
  write('shared.txt', 'three'); commit('plain later work');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  const run = async (args: string[]) => (await execAsync('git', args,
    { cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  return { dir, run, sha1, sha2, oid: git('rev-parse', 'HEAD').trim() };
}

const tree = (oid: string) => ({ mode: '100644', type: 'blob', oid });

function entry(path: string, atCommit: JobCurrentEntry['atCommit']): JobCurrentEntry {
  return { path, status: 'unchanged', atCommit, atCurrent: atCommit };
}

function current(jobId: string, commit: JobCurrentReport['commit'], entries: JobCurrentEntry[], omittedPaths = 0): JobCurrentReport {
  return {
    jobId, ref: 'origin/master', resolvedRef: 'a'.repeat(40), scanBound: 1000, scanned: 3,
    scanMayBeTruncated: false, matchesTruncated: false, commit, pathBound: 200, omittedPaths,
    summary: { unchanged: entries.length, changed: 0, absentNow: 0, absentAtBoth: 0 }, entries,
  };
}

const COMMIT = (sha: string, pr: number) => ({ sha, date: '2026-10-31T00:00:00Z', pr });

function batch(jobs: JobCurrentReport[]): JobCurrentBatchReport {
  return {
    schemaVersion: 1, ref: 'origin/master', resolvedRef: 'a'.repeat(40), scanBound: 1000, scanned: 3,
    scanMayBeTruncated: false, jobs,
    totals: { jobs: jobs.length, matched: 0, unchanged: 0, changed: 0, absentNow: 0, absentAtBoth: 0, omittedPaths: 0 },
  };
}

it('compares two real bridge commits with one batch read and a sorted per-path verdict', async () => {
  const repo = makeRepo();
  try {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return repo.run(args); };
    const read = vi.fn<JobCompareReader>(ids => jobCurrentBatch(ids, run));
    const report = await jobCompare('RQ-CMP-1', 'RQ-CMP-2', read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(['RQ-CMP-1', 'RQ-CMP-2']);
    expect(report).toMatchObject({
      schemaVersion: 1, ref: 'origin/master', resolvedRef: repo.oid, comparable: true, sharedPathsComplete: true,
      unmatched: [], totals: { shared: 3, identical: 1, different: 1, bothAbsent: 1 },
    });
    expect(report.jobs.map(job => job.jobId)).toEqual(['RQ-CMP-1', 'RQ-CMP-2']);
    expect(report.jobs[0]!).toMatchObject({ matched: true, commit: { sha: repo.sha1, pr: 7 }, omittedPaths: 0, comparedPaths: 4 });
    expect(report.jobs[1]!).toMatchObject({ matched: true, commit: { sha: repo.sha2, pr: 8 } });
    const shared = report.entries.find(item => item.path === 'shared.txt')!;
    expect(shared.status).toBe('different');
    expect(shared.atFirst).toMatchObject({ mode: '100644', type: 'blob' });
    expect(shared.atFirst!.oid).not.toBe(shared.atSecond!.oid);
    expect(report.entries.find(item => item.path === 'same.txt')).toMatchObject({ status: 'identical' });
    expect(report.entries.find(item => item.path === 'same.txt')!.atFirst).toEqual(report.entries.find(item => item.path === 'same.txt')!.atSecond);
    expect(report.entries.find(item => item.path === 'gone.txt')).toEqual({ path: 'gone.txt', status: 'both-absent', atFirst: null, atSecond: null });
    // Only paths both jobs touched are compared; the job-unique files never appear.
    expect(report.entries.map(item => item.path)).toEqual(['gone.txt', 'same.txt', 'shared.txt']);
    expect(JSON.stringify(report)).not.toContain('secret words');
    // Read-only verbs only; never a fetch or mutation.
    expect(new Set(calls.map(call => call[0]))).toEqual(new Set(['rev-parse', 'log', 'diff-tree', 'ls-tree']));
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});

it('reports unmatched jobs explicitly, never as identical, and bounded lists as non-disjoint', async () => {
  const shared = (path: string) => entry(path, tree('b'.repeat(40)));
  const one = current('RQ-X-1', COMMIT('1'.repeat(40), 1), [shared('a.txt'), shared('b.txt')]);
  const missing = current('RQ-X-9', null, []);
  const unmatched = await jobCompare('RQ-X-1', 'RQ-X-9', async () => batch([one, missing]));
  expect(unmatched).toMatchObject({ comparable: false, sharedPathsComplete: false, unmatched: ['RQ-X-9'], entries: [] });
  expect(unmatched.totals).toEqual({ shared: 0, identical: 0, different: 0, bothAbsent: 0 });
  expect(unmatched.jobs[1]!).toMatchObject({ jobId: 'RQ-X-9', matched: false, commit: null, comparedPaths: 0 });

  const bounded = current('RQ-X-2', COMMIT('2'.repeat(40), 2), [shared('b.txt'), entry('c.txt', null)], 5);
  const partial = await jobCompare('RQ-X-1', 'RQ-X-2', async () => batch([one, bounded]));
  expect(partial).toMatchObject({ comparable: true, sharedPathsComplete: false, unmatched: [] });
  expect(partial.entries).toEqual([{ path: 'b.txt', status: 'identical', atFirst: tree('b'.repeat(40)), atSecond: tree('b'.repeat(40)) }]);
  expect(partial.jobs[1]!.omittedPaths).toBe(5);

  // Different sides: a path present on one side only is different, not identical.
  const oneSided = current('RQ-X-3', COMMIT('3'.repeat(40), 3), [entry('b.txt', null)]);
  const mixed = await jobCompare('RQ-X-1', 'RQ-X-3', async () => batch([one, oneSided]));
  expect(mixed.entries).toEqual([{ path: 'b.txt', status: 'different', atFirst: tree('b'.repeat(40)), atSecond: null }]);

  // No shared paths: a complete empty list, but the caller still sees both sides.
  const disjoint = current('RQ-X-4', COMMIT('4'.repeat(40), 4), [entry('z.txt', tree('c'.repeat(40)))]);
  const none = await jobCompare('RQ-X-1', 'RQ-X-4', async () => batch([one, disjoint]));
  expect(none).toMatchObject({ comparable: true, sharedPathsComplete: true, entries: [], totals: { shared: 0 } });
});

it('sorts shared paths deterministically regardless of reader order', async () => {
  const left = current('RQ-S-1', COMMIT('5'.repeat(40), 5), ['z.txt', 'a.txt', 'M.txt', 'a/b.txt']
    .map(path => entry(path, tree('d'.repeat(40)))));
  const right = current('RQ-S-2', COMMIT('6'.repeat(40), 6), ['a/b.txt', 'M.txt', 'z.txt', 'a.txt']
    .map(path => entry(path, tree('d'.repeat(40)))));
  const report = await jobCompare('RQ-S-1', 'RQ-S-2', async () => batch([left, right]));
  expect(report.entries.map(item => item.path)).toEqual(['M.txt', 'a.txt', 'a/b.txt', 'z.txt']);
});

it('validates ids before any read and rejects a reader that omits a requested job', async () => {
  const read = vi.fn<JobCompareReader>(async () => batch([]));
  for (const [a, b] of [['RQ-A', 'RQ-A'], ['rq-a', 'RQ-B'], ['nope', 'RQ-B'], ['RQ-A', 'RQ-B C'], [7, 'RQ-B'], ['RQ-A', null]] as unknown[][]) {
    await expect(jobCompare(a as string, b as string, read)).rejects.toThrow('invalid job compare arguments');
  }
  expect(read).not.toHaveBeenCalled();
  await expect(jobCompare('RQ-A', 'RQ-B', read)).rejects.toThrow('job compare reader omitted a requested job');
});

it('serves the CLI: usage, text and JSON on a real fixture, and a scrubbed git failure', async () => {
  const repo = makeRepo();
  const nogit = mkdtempSync(join(tmpdir(), 'job-compare-nogit-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.chdir(nogit); // exit 2 proves rejection happened before any git call, which would exit 1 here
    for (const args of [
      [] as string[], ['RQ-CMP-1'], ['RQ-CMP-1', 'RQ-CMP-2', 'RQ-CMP-3'], ['RQ-CMP-1', 'RQ-CMP-1'],
      ['RQ-CMP-1', 'RQ-CMP-2', '--json', '--json'], ['RQ-CMP-1', '--bogus', 'RQ-CMP-2'], ['nope', 'RQ-CMP-2'],
      ['RQ-CMP-1', 'RQ-CMP-2', '--help'], ['rq-cmp-1', 'RQ-CMP-2'], ['RQ-CMP-1', 'RQ-CMP-2', '--status', 'x'],
    ]) {
      expect(await cmdFleetJobCompare(args)).toBe(2);
    }
    for (const flag of ['--help', '-h']) {
      expect(await cmdFleetJobCompare([flag])).toBe(0);
      expect(log.mock.calls.at(-1)![0]).toContain('Usage: ashlr fleet job-compare');
    }
    process.chdir(repo.dir);
    expect(await cmdFleetJobCompare(['RQ-CMP-1', 'RQ-CMP-2', '--json'])).toBe(0);
    const out = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(out).toMatchObject({ schemaVersion: 1, resolvedRef: repo.oid, comparable: true, sharedPathsComplete: true });
    expect(out.entries.map((item: { path: string }) => item.path)).toEqual(['gone.txt', 'same.txt', 'shared.txt']);
    expect(out.totals).toEqual({ shared: 3, identical: 1, different: 1, bothAbsent: 1 });
    expect(JSON.stringify(out)).not.toContain('secret words');

    const before = log.mock.calls.length;
    expect(await cmdFleetJobCompare(['RQ-CMP-2', 'RQ-CMP-1'])).toBe(0);
    const lines = log.mock.calls.slice(before).map(call => String(call[0]));
    expect(lines.some(line => line.includes('different') && line.includes('shared.txt'))).toBe(true);
    expect(lines.some(line => line.includes('identical') && line.includes('same.txt'))).toBe(true);
    expect(lines.some(line => line.includes('both-absent') && line.includes('gone.txt'))).toBe(true);
    expect(lines.some(line => line.includes('Compared 3 shared literal paths: 1 identical, 1 different, 1 both-absent.'))).toBe(true);
    expect(lines.some(line => line.includes('secret words'))).toBe(false);

    const beforeMissing = log.mock.calls.length;
    expect(await cmdFleetJobCompare(['RQ-CMP-1', 'RQ-NOPE-9'])).toBe(0);
    const missing = log.mock.calls.slice(beforeMissing).map(call => String(call[0]));
    expect(missing.some(line => line.includes('RQ-NOPE-9: unmatched') && line.includes('Not identical'))).toBe(true);
    expect(missing.some(line => line.includes('Not compared: RQ-NOPE-9 unmatched')
      && line.includes('never reported as identical'))).toBe(true);
    expect(missing.some(line => line.includes('Compared '))).toBe(false);
    expect(await cmdFleetJobCompare(['RQ-CMP-1', 'RQ-NOPE-9', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ comparable: false, unmatched: ['RQ-NOPE-9'], entries: [] });

    process.chdir(nogit);
    const callsBeforeFailure = log.mock.calls.length;
    expect(await cmdFleetJobCompare(['RQ-CMP-1', 'RQ-CMP-2'])).toBe(1);
    expect(error.mock.calls.at(-1)![0]).toContain('unable to compare jobs from git');
    expect(log.mock.calls.slice(callsBeforeFailure)).toEqual([]);
  } finally {
    process.chdir(cwd); log.mockRestore(); error.mockRestore();
    rmSync(repo.dir, { recursive: true, force: true }); rmSync(nogit, { recursive: true, force: true });
  }
});
