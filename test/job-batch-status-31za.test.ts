import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJobBatchStatus } from '../examples/agents/job-batch-status.js';
import { getFleetJobDetail, type FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';

const time = '2026-02-03T00:00:00.000Z';
const detail = (job: string): FleetJobDetailV1 => ({
  schema: 'fleet.job.v1', generatedAt: time, job, state: 'published', lane: 'fake-lane', model: 'fake-model',
  tier: 'fake-tier', pid: null, launchedAt: null, baseSha: null, branch: null, promptBytes: null,
  publish: { prUrl: `https://example.invalid/pull/${job}`, testLine: 'TEST fake passed', autoMerge: true, sensitive: null },
  notes: { hasNotes: false, hasBody: false, notesBytes: null },
  log: { source: 'archived', bytes: 1234, tail: ['fake tail line'], truncated: false },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' },
});
const args = (...jobs: string[]) => jobs.flatMap(job => ['--job', job]);
const run = async (argv: readonly string[], deps: Parameters<typeof runJobBatchStatus>[1]) => {
  let output = '';
  const code = await runJobBatchStatus(argv, { now: () => new Date(time), ...deps, write: text => { output += text; } });
  return { code, output, value: output.startsWith('{') ? JSON.parse(output) : null };
};

describe('job batch status', () => {
  it('bounds in-flight detail reads at four while reading every job', async () => {
    let inFlight = 0, peak = 0;
    const readDetail = vi.fn(async (job: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return detail(job);
    });
    const jobs = Array.from({ length: 9 }, (_, index) => `JOB-${index}`);
    const result = await run(args(...jobs), { readDetail });
    expect(result.code).toBe(0);
    expect(result.value.complete).toBe(true);
    expect(readDetail).toHaveBeenCalledTimes(9);
    expect(peak).toBe(4);
  });

  it('reports first-given order even when readers finish out of order', async () => {
    const resolvers = new Map<string, () => void>();
    const readDetail = vi.fn((job: string) => new Promise<FleetJobDetailV1>(resolve => {
      resolvers.set(job, () => resolve(detail(job)));
    }));
    let output = '';
    const pending = runJobBatchStatus(args('JOB-C', 'JOB-A', 'JOB-B'), {
      readDetail, now: () => new Date(time), write: text => { output += text; },
    });
    resolvers.get('JOB-B')!();
    resolvers.get('JOB-C')!();
    resolvers.get('JOB-A')!();
    expect(await pending).toBe(0);
    const value = JSON.parse(output);
    expect(value.jobs.map((entry: { job: string }) => entry.job)).toEqual(['JOB-C', 'JOB-A', 'JOB-B']);
    expect(value.jobs[0]).toMatchObject({ state: 'published', lane: 'fake-lane', model: 'fake-model',
      publish: { prUrl: 'https://example.invalid/pull/JOB-C', testLine: 'TEST fake passed' },
      logSource: 'archived', sources: { publish: 'healthy', log: 'healthy' } });
    expect(output).not.toContain('fake tail line');
  });

  it('marks one failed reader unavailable without losing healthy jobs', async () => {
    const readDetail = vi.fn(async (job: string) => {
      if (job === 'JOB-BAD') throw new Error('/fake/private/path exploded');
      return detail(job);
    });
    const result = await run(args('JOB-OK-1', 'JOB-BAD', 'JOB-OK-2'), { readDetail });
    expect(result.code).toBe(1);
    expect(result.value.complete).toBe(false);
    expect(readDetail).toHaveBeenCalledTimes(3);
    expect(result.value.jobs.map((entry: { job: string; state: string }) => [entry.job, entry.state]))
      .toEqual([['JOB-OK-1', 'published'], ['JOB-BAD', 'unavailable'], ['JOB-OK-2', 'published']]);
    expect(result.value.jobs[1]).toEqual({ job: 'JOB-BAD', state: 'unavailable', lane: null, model: null,
      publish: null, logSource: null, sources: null });
    expect(result.value.jobs[2].publish.prUrl).toBe('https://example.invalid/pull/JOB-OK-2');
    expect(result.output).not.toContain('/fake/private/path');
  });

  it('reads and reports repeated ids once, retaining first order', async () => {
    const readDetail = vi.fn(async (job: string) => detail(job));
    const result = await run(args('JOB-B', 'JOB-A', 'JOB-B', 'JOB-C', 'JOB-A'), { readDetail });
    expect(result.code).toBe(0);
    expect(readDetail.mock.calls).toEqual([['JOB-B'], ['JOB-A'], ['JOB-C']]);
    expect(result.value.jobs.map((entry: { job: string }) => entry.job)).toEqual(['JOB-B', 'JOB-A', 'JOB-C']);
    expect(result.value.jobs).toHaveLength(3);
  });

  it('composes the real detail reader and emits no log text or paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-batch-fake-'));
    try {
      await writeFile(join(dir, 'JOB-DEMO.launch'), 'launched JOB-DEMO fake-lane pid 4242 base abc1234\n');
      await writeFile(join(dir, 'JOB-DEMO.base.meta'), 'MODEL fake-lane fake-tier fake-model\n');
      await writeFile(join(dir, 'JOB-DEMO.log'), 'fake secret-ish log line\n');
      await writeFile(join(dir, 'JOB-DEMO.publish'), 'RESULT PR https://example.invalid/pull/7\nTEST fake suite passed\n');
      const result = await run(args('JOB-DEMO', 'JOB-GONE'), { readDetail: id => getFleetJobDetail(id, { runsDir: dir }) });
      expect(result.code).toBe(0);
      expect(result.value.jobs[0]).toMatchObject({ job: 'JOB-DEMO', state: 'published', lane: 'fake-lane',
        model: 'fake-model', publish: { prUrl: 'https://example.invalid/pull/7', testLine: 'TEST fake suite passed' },
        logSource: 'live', sources: { publish: 'healthy', log: 'healthy' } });
      expect(result.value.jobs[1]).toMatchObject({ job: 'JOB-GONE', state: 'unknown', lane: null, model: null,
        publish: null, logSource: 'missing' });
      expect(result.output).not.toContain('fake secret-ish log line');
      expect(result.output).not.toContain(dir);
      expect(result.output).not.toContain('4242');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('accepts help and emits stable JSON errors without calling readers', async () => {
    const readDetail = vi.fn(async (job: string) => detail(job));
    expect((await run(['--help'], { readDetail })).code).toBe(0);
    const help = await run(['--help'], {});
    expect(help.output).toContain('npx tsx examples/agents/job-batch-status.ts --job ID');
    for (const argv of [[], ['--job'], args('bad id'), ['--bogus', 'JOB-1'], args('JOB-1', 'JOB-1\n'),
      args(...Array.from({ length: 21 }, (_, index) => `JOB-${index}`))]) {
      const result = await run(argv, { readDetail });
      expect(result.code).toBe(2);
      expect(result.value).toEqual({ schema: 'fleet.job-batch-status.error.v1', error: 'invalid_arguments' });
    }
    expect(readDetail).not.toHaveBeenCalled();
  });
});
