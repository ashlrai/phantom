import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runJobEditCollisions } from '../examples/agents/job-edit-collisions.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../src/core/fleet/runs-job-changes.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const time = '2026-01-01T00:00:00.000Z';
const changes = (job: string, paths: string[]): FleetJobChangesV1 => ({
  schema: 'fleet.job.changes.v1', job, generatedAt: time, state: 'live', baseSha: 'abcdef1',
  files: paths.map(path => ({ path, added: 1, removed: 0, status: 'modified' })),
  totals: { files: paths.length, added: paths.length, removed: 0 }, truncated: false,
});
const args = (...jobs: string[]) => jobs.flatMap(job => ['--job', job]);
async function report(jobs: string[], readChanges: (job: string) => Promise<FleetJobChangesV1>) {
  let output = '';
  const code = await runJobEditCollisions(args(...jobs), {
    readChanges, now: () => new Date(time), write: text => { output += text; },
  });
  return { code, value: JSON.parse(output) };
}

describe('fleet job edit collisions', () => {
  it('composes the real changes reader with isolated fake state and groups exact paths', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'fake-job-collisions-'));
    try {
      const runsDir = join(homeDir, 'runs');
      await mkdir(runsDir);
      for (const job of ['JOB-ONE', 'JOB-TWO', 'JOB-THREE']) {
        const repo = join(homeDir, job);
        await mkdir(repo);
        await writeFile(join(runsDir, `${job}.base`), `abcdef1 fake-branch ${repo}\n`);
      }
      const fakePaths: Record<string, string[]> = {
        'JOB-ONE': ['shared/file.ts', 'one/same.ts', 'only-one.ts'],
        'JOB-TWO': ['shared/file.ts', 'two/same.ts', 'only-two.ts'],
        'JOB-THREE': ['shared/file.ts', 'one/same.ts'],
      };
      const runner = vi.fn<GitRunner>(async (_bin, gitArgs, options) => {
        const job = options!.cwd!.split('/').at(-1)!;
        const stdout = gitArgs[0] === 'diff' ? fakePaths[job]!.map(path => `1\t0\t${path}\0`).join('') : '';
        return { code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false };
      });
      const result = await report(Object.keys(fakePaths), job => getFleetJobChanges(job, { homeDir, runsDir, runner }));
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({ schema: 'fleet.job-edit-collisions.v1', generatedAt: time, complete: true,
        intersections: [
          { path: 'one/same.ts', jobs: ['JOB-ONE', 'JOB-THREE'] },
          { path: 'shared/file.ts', jobs: ['JOB-ONE', 'JOB-TWO', 'JOB-THREE'] },
        ],
      });
      expect(result.value.sources).toEqual(['JOB-ONE', 'JOB-TWO', 'JOB-THREE'].map(job => ({
        job, generatedAt: expect.any(String), state: 'live', truncated: false,
      })));
      expect(JSON.stringify(result.value)).not.toContain(homeDir);
      expect(runner).toHaveBeenCalledTimes(6);
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });

  it('normalizes relative paths, deduplicates a job’s files, and keeps different directories distinct', async () => {
    const data = {
      'JOB-ONE': changes('JOB-ONE', ['./src//file.ts', 'src/file.ts', 'one/same.ts']),
      'JOB-TWO': changes('JOB-TWO', ['src/file.ts', 'two/same.ts']),
    };
    const result = await report(Object.keys(data), async job => data[job as keyof typeof data]);
    expect(result.value.intersections).toEqual([{ path: 'src/file.ts', jobs: ['JOB-ONE', 'JOB-TWO'] }]);
    const distinct = await report(['JOB-ONE', 'JOB-TWO'], async job => changes(job, [job === 'JOB-ONE' ? 'one/same.ts' : 'two/same.ts']));
    expect(distinct.value).toMatchObject({ complete: true, intersections: [] });
  });

  it('retains observed collisions and source metadata when evidence is missing, degraded, truncated, or throws', async () => {
    const data = {
      'JOB-ONE': changes('JOB-ONE', ['shared.ts']),
      'JOB-TWO': { ...changes('JOB-TWO', ['shared.ts']), state: 'degraded' as const },
      'JOB-THREE': { ...changes('JOB-THREE', []), state: 'missing' as const },
      'JOB-FOUR': { ...changes('JOB-FOUR', []), truncated: true },
    };
    const result = await report([...Object.keys(data), 'JOB-FIVE'], async job => {
      if (job === 'JOB-FIVE') throw new Error('/fake/private/error');
      return data[job as keyof typeof data];
    });
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({ complete: false, intersections: [{ path: 'shared.ts', jobs: ['JOB-ONE', 'JOB-TWO'] }], sources: [
      { job: 'JOB-ONE', generatedAt: time, state: 'live', truncated: false },
      { job: 'JOB-TWO', generatedAt: time, state: 'degraded', truncated: false },
      { job: 'JOB-THREE', generatedAt: time, state: 'missing', truncated: false },
      { job: 'JOB-FOUR', generatedAt: time, state: 'live', truncated: true },
      { job: 'JOB-FIVE', generatedAt: null, state: 'unavailable', truncated: null },
    ] });
    expect(JSON.stringify(result.value)).not.toContain('/fake/private/error');
    const empty = await report(['JOB-ONE', 'JOB-TWO'], async job => ({ ...changes(job, []), state: job === 'JOB-ONE' ? 'missing' : 'live' }));
    expect(empty.value).toMatchObject({ complete: false, intersections: [] });
  });

  it('marks unsafe paths incomplete rather than silently claiming a complete comparison', async () => {
    const result = await report(['JOB-ONE', 'JOB-TWO'], async job => changes(job, ['../escape', '/absolute', '.', 'valid.ts']));
    expect(result.code).toBe(1);
    expect(result.value).toMatchObject({ complete: false, intersections: [{ path: 'valid.ts', jobs: ['JOB-ONE', 'JOB-TWO'] }] });
  });

  it('rejects duplicates, malformed IDs, invalid counts and flags before calling any reader', async () => {
    const readChanges = vi.fn(async (job: string) => changes(job, []));
    for (const input of [args('JOB-ONE', 'JOB-ONE'), args('JOB-ONE'), args(...Array.from({ length: 21 }, (_, i) => `JOB-${i}`)),
      args('JOB-ONE', 'JOB-TWO;touch /fake/pwned'), ['--job', 'JOB-ONE', '--other', 'JOB-TWO'], ['--job', 'JOB-ONE', '--job']]) {
      let output = '';
      expect(await runJobEditCollisions(input, { readChanges, write: text => { output += text; } })).toBe(2);
      expect(JSON.parse(output)).toEqual({ schema: 'fleet.job-edit-collisions.error.v1', error: 'invalid_arguments' });
    }
    expect(readChanges).not.toHaveBeenCalled();
  });

  it('runs at most three readers at once and eventually reads every selected job', async () => {
    const jobs = Array.from({ length: 8 }, (_, i) => `JOB-${i}`);
    let active = 0, peak = 0;
    const pending: Array<() => void> = [];
    const readChanges = vi.fn(async (job: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => pending.push(resolve));
      active--;
      return changes(job, []);
    });
    const result = report(jobs, readChanges);
    expect(readChanges).toHaveBeenCalledTimes(3);
    for (let i = 0; i < jobs.length; i++) {
      pending[i]!();
      await vi.waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(Math.min(i + 4, jobs.length)));
    }
    expect((await result).value).toMatchObject({ complete: true, intersections: [] });
    expect(peak).toBe(3);
    expect(readChanges.mock.calls.map(([job]) => job)).toEqual(jobs);
  });

  it('passes validated IDs directly to the injected reader and supports help', async () => {
    const readChanges = vi.fn(async (job: string) => changes(job, []));
    const result = await report(['FAKE-ONE', 'FAKE-TWO'], readChanges);
    expect(result.code).toBe(0);
    expect(readChanges.mock.calls).toEqual([['FAKE-ONE'], ['FAKE-TWO']]);
    let output = '';
    expect(await runJobEditCollisions(['--help'], { write: text => { output += text; } })).toBe(0);
    expect(output).toContain('--job ID --job ID');
  });
});
