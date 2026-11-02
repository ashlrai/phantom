import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiRegression } from '../src/cli/fleet-ci-regression.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const repo = 'ashlrai/phantom';
const run = (id: number, date: string, extra: Record<string, unknown> = {}) => ({
  id, workflow_id: 7, head_branch: 'master', head_sha: `sha-${id}`, event: 'schedule',
  status: 'completed', conclusion: 'success', created_at: date, ...extra,
});
const target = run(20, '2026-11-01T01:00:00Z', { conclusion: 'failure' });
const prior = run(10, '2026-10-31T01:00:00Z');
const step = (name: string, conclusion: string | null) => ({ name, conclusion });
const job = (name: string, conclusion: string | null, steps = [step('Checkout', 'success')]) => ({ name, conclusion, steps });
const oldJobs = [job('Build', 'success', [step('Checkout', 'success'), step('Compile', 'success')]),
  job('Tests', 'success', [step('Unit tests', 'success')]), job('Old job', 'success')];
const newJobs = [job('Build', 'success', [step('Checkout', 'success'), step('Compile', 'success')]),
  job('Tests', 'failure', [step('Unit tests', 'failure')]), job('New job', 'success')];

type Fixture = { target?: unknown; runs?: unknown[]; targetJobs?: unknown[]; baselineJobs?: unknown[];
  fail?: boolean; cap?: boolean };
function fixture(options: Fixture = {}): CloudGh {
  return async args => {
    expect(args[0]).toBe('api');
    expect(args).toHaveLength(2);
    const path = args[1]!;
    if (options.fail) return { ok: false, stdout: '', stderr: 'secret-like stderr ignored' };
    const page = Number(new URL(`https://example.test/${path}`).searchParams.get('page') ?? 1);
    let data: unknown;
    if (path.includes('/workflows/')) {
      const rows = options.cap ? Array.from({ length: 100 }, (_, i) => run(1000 + page * 100 + i, '2026-11-02T01:00:00Z')) : options.runs ?? [target, prior];
      data = { total_count: options.cap ? 500 : rows.length, workflow_runs: rows };
    } else if (path.includes('/jobs')) {
      const rows = path.includes('/runs/20/') ? options.targetJobs ?? newJobs : options.baselineJobs ?? oldJobs;
      data = { total_count: rows.length, jobs: rows };
    } else data = options.target ?? target;
    return { ok: true, stdout: JSON.stringify(data), stderr: '' };
  };
}
async function execute(options: Fixture = {}) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetCiRegression(['--repo', repo, '--run', '20', '--json'], { gh: fixture(options) });
  const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  log.mockRestore();
  return { code, output };
}
afterEach(() => vi.restoreAllMocks());

describe('fleet ci-regression command', () => {
  it('compares a realistic daily run and identifies the newly failing job and step', async () => {
    const { code, output } = await execute();
    expect(code).toBe(0);
    expect(output).toMatchObject({ v: 1, status: 'complete', target: { id: 20, head_sha: 'sha-20' },
      baseline: { id: 10, head_sha: 'sha-10' }, comparison: {
        newlyFailingJobs: ['Tests'], newlyFailingSteps: [{ job: 'Tests', step: 'Unit tests' }],
        newJobs: ['New job'], missingJobs: ['Old job'], ambiguous: [], unknown: [],
      } });
  });
  it('selects the newest successful scheduled run strictly before the target in the same workflow and branch', async () => {
    const rows = [run(30, '2026-11-02T00:00:00Z'), run(18, '2026-10-31T22:00:00Z', { head_branch: 'other' }),
      run(17, '2026-10-31T21:00:00Z', { workflow_id: 8 }),
      run(16, '2026-10-31T20:00:00Z', { event: 'pull_request' }),
      run(15, '2026-10-31T19:00:00Z', { conclusion: 'failure' }),
      run(14, '2026-11-01T01:00:00Z'), prior, run(12, '2026-10-31T10:00:00Z')];
    const { output } = await execute({ runs: rows });
    expect(output.baseline.id).toBe(12);
  });
  it('keeps cancellation and skipped conclusions distinct from failure', async () => {
    const { output } = await execute({ targetJobs: [job('Tests', 'cancelled', [step('Run', 'skipped')])],
      baselineJobs: [job('Tests', 'success', [step('Run', 'success')])] });
    expect(output.comparison.newlyFailingJobs).toEqual([]);
    expect(output.comparison.newlyFailingSteps).toEqual([]);
    expect(output.jobs.target[0]).toMatchObject({ conclusion: 'cancelled', steps: [{ conclusion: 'skipped' }] });
  });
  it('reports repeated job and step names as ambiguous without silently pairing them', async () => {
    const { output } = await execute({ targetJobs: [job('Matrix', 'failure'), job('Matrix', 'success'),
      job('Other', 'failure', [step('Run', 'failure'), step('Run', 'success')])],
    baselineJobs: [job('Matrix', 'success'), job('Other', 'success', [step('Run', 'success')])] });
    expect(output.status).toBe('unknown');
    expect(output.comparison.ambiguous).toEqual([{ job: 'Matrix' }, { job: 'Other', step: 'Run' }]);
    expect(output.comparison.newlyFailingJobs).toEqual(['Other']);
    expect(output.comparison.newlyFailingSteps).toEqual([]);
    expect(output.jobs.target.filter((j: { name: string }) => j.name === 'Matrix')).toHaveLength(2);
  });
  it('reports a capped run list as partial and makes no definitive comparison', async () => {
    const { output } = await execute({ cap: true });
    expect(output.status).toBe('partial-source');
    expect(output.sources.runsPartial).toBe(true);
    expect(output.comparison).toBeNull();
  });
  it('reports missing baseline explicitly', async () => {
    const { output } = await execute({ runs: [target] });
    expect(output).toMatchObject({ status: 'no-baseline', baseline: null, comparison: null });
  });
  it('returns nonzero for read errors and refuses non-scheduled targets', async () => {
    const failed = await execute({ fail: true });
    expect(failed.code).toBe(1);
    expect(failed.output).toMatchObject({ status: 'unknown', error: 'GitHub read failed' });
    expect(JSON.stringify(failed.output)).not.toContain('secret-like');
    const unscheduled = await execute({ target: { ...target, event: 'push' } });
    expect(unscheduled.code).toBe(1);
    expect(unscheduled.output.error).toBe('target run is not scheduled');
  });
  it('marks unfinished conclusions unknown', async () => {
    const { output } = await execute({ targetJobs: [job('Tests', null, [step('Run', null)])],
      baselineJobs: [job('Tests', 'success', [step('Run', 'success')])] });
    expect(output.status).toBe('unknown');
    expect(output.comparison.unknown).toHaveLength(2);
    expect(output.comparison.newlyFailingJobs).toEqual([]);
  });
});
