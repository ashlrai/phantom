import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { jobBatchAudit } from '../src/core/fleet/job-batch-audit.js';
import { jobCurrentBatch } from '../src/core/fleet/job-current-batch.js';
import { JOB_BATCH_MAX } from '../src/core/fleet/job-history-batch.js';
import { cmdFleetJobBatchAudit } from '../src/cli/fleet-job-batch-audit.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'batch-audit-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path: string, value: string) => writeFileSync(join(dir, path), value);
  const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); };
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  write('base', 'base'); commit('base');
  write('A [x].txt', 'a'); commit('bridge(RQ-A): fake (#1)');
  write('A [x].txt', 'b'); write('deleted!', 'b'); commit('bridge(RQ-B): fake (#2)');
  rmSync(join(dir, 'deleted!')); commit('bridge(RQ-C): fake (#3)');
  write('disjoint.txt', 'different'); commit('bridge(RQ-D): fake (#4)');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  return { dir, git, run: async (args: string[]) => git(...args) };
}

it('groups transitive literal overlaps including deletions while retaining unknowns and input order', async () => {
  const f = fixture();
  try {
    const reader = vi.fn((ids: string[]) => jobCurrentBatch(ids, f.run));
    const report = await jobBatchAudit(['RQ-C', 'RQ-D', 'RQ-A', 'RQ-B', 'RQ-MISSING'], reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(report.groups).toEqual([
      { jobs: ['RQ-C', 'RQ-A', 'RQ-B'], sharedPaths: ['deleted!', 'A [x].txt'] },
      { jobs: ['RQ-D'], sharedPaths: [] }, { jobs: ['RQ-MISSING'], sharedPaths: [] },
    ]);
    expect(report.resolvedRef).toBe(f.git('rev-parse', 'HEAD').trim());
    expect(report.jobs[0]!.entries).toContainEqual(expect.objectContaining({ path: 'deleted!', status: 'absent-at-both' }));
    expect(report.jobs[4]).toMatchObject({ match: 'unknown', commit: null });
    expect(report.incomplete).toBe(true);
    const bounded = vi.fn(async () => ({ ...report, scanMayBeTruncated: true,
      jobs: report.jobs.map((job, i) => i === 0 ? { ...job, omittedPaths: 1 } : job) }));
    const truncated = await jobBatchAudit(['RQ-C', 'RQ-D', 'RQ-A', 'RQ-B', 'RQ-MISSING'], bounded);
    expect(bounded).toHaveBeenCalledTimes(1);
    expect(truncated).toMatchObject({ scanMayBeTruncated: true, incomplete: true });
    expect(truncated.jobs[0]!.omittedPaths).toBe(1);
    const cases = vi.fn(async () => ({ ...report, jobs: report.jobs.slice(0, 2).map((job, i) => ({ ...job,
      entries: [{ ...report.jobs[0]!.entries[0]!, path: i ? 'File[!]' : 'file[!]' }] })) }));
    const distinct = await jobBatchAudit(['RQ-C', 'RQ-D'], cases);
    expect(cases).toHaveBeenCalledTimes(1);
    expect(distinct.groups).toEqual([{ jobs: ['RQ-C'], sharedPaths: [] }, { jobs: ['RQ-D'], sharedPaths: [] }]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

it('rejects invalid batches before reading', async () => {
  const reader = vi.fn(() => { throw new Error('must not read'); });
  for (const ids of [[], ['bad'], ['RQ-A', 'RQ-A'], Array.from({ length: JOB_BATCH_MAX + 1 }, (_, i) => `RQ-${i}`)]) {
    await expect(jobBatchAudit(ids, reader)).rejects.toThrow('invalid');
  }
  expect(reader).not.toHaveBeenCalled();
});

it('prints text and sanitized JSON, rejects usage, and reports read errors', async () => {
  const f = fixture(), cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.chdir(f.dir);
    expect(await cmdFleetJobBatchAudit(['RQ-A', 'RQ-B', 'RQ-MISSING', '--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report.groups[0]).toEqual({ jobs: ['RQ-A', 'RQ-B'], sharedPaths: ['A [x].txt'] });
    expect(report.jobs[2].match).toBe('unknown');
    expect(await cmdFleetJobBatchAudit(['RQ-A', 'RQ-B'])).toBe(0);
    const output = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('Group 1: RQ-A, RQ-B');
    expect(output).toContain('unchanged does not prove correctness');
    expect(await cmdFleetJobBatchAudit(['RQ-A', 'RQ-A'])).toBe(2);
    expect(await cmdFleetJobBatchAudit(['RQ-A', '--json', '--json'])).toBe(2);
    process.chdir(tmpdir());
    expect(await cmdFleetJobBatchAudit(['RQ-A'])).toBe(1);
    expect(error.mock.calls.at(-1)![0]).toBe('error: unable to read job batch audit from git');
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(f.dir, { recursive: true, force: true }); }
});
