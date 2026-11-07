import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiFailures } from '../src/cli/fleet-ci-failures.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const now = () => new Date('2026-11-01T06:00:00.000Z');
const from = '2026-10-31T06%3A00%3A00.000Z';
const runsEndpoint = (page: number) => `repos/ashlrai/phantom/actions/runs?created=%3E%3D${from}&per_page=25&page=${page}`;
const jobsEndpoint = (id: number, attempt = 1, page = 1) => `repos/ashlrai/phantom/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${page}`;
const run = (id: number, overrides: Record<string, unknown> = {}) => ({ id, run_attempt: 1, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: `sha${id}`, status: 'completed', conclusion: 'failure', created_at: '2026-10-31T08:00:00Z', updated_at: `2026-10-31T${String(10 + id % 10).padStart(2, '0')}:00:00Z`, html_url: `https://github.com/ashlrai/phantom/actions/runs/${id}`, pull_requests: [{ number: id }], ...overrides });
const job = (id: number, conclusion: string | null = 'failure', overrides: Record<string, unknown> = {}) => ({ id, name: 'Quick typecheck', status: 'completed', conclusion, started_at: '2026-10-31T09:00:00Z', completed_at: '2026-10-31T09:10:00Z', html_url: `https://github.com/ashlrai/phantom/actions/runs/1/job/${id}`, ...overrides });
function fakeGh(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const gh: CloudGh = async args => {
    calls.push(args);
    const response = responses[args[1]!];
    return response === undefined ? { ok: false, stdout: '', stderr: 'private details' } : { ok: true, stdout: JSON.stringify(response), stderr: '' };
  };
  return { gh, calls };
}
let output: string[];
let error: string;
beforeEach(() => {
  output = []; error = '';
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { output.push(String(line)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((line: string | Uint8Array) => { error += String(line); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet ci-failures', () => {
  it('groups repeated PR failures, preserves reruns, and separates nightly and cancellations', async () => {
    const fake = fakeGh({
      [runsEndpoint(1)]: { total_count: 5, workflow_runs: [run(1, { run_attempt: 2 }), run(2), run(3, { event: 'schedule', pull_requests: [] }), run(4, { conclusion: 'cancelled', pull_requests: [] }), run(5, { run_attempt: 2, conclusion: 'success', pull_requests: [{ number: 1 }] })] },
      [jobsEndpoint(1)]: { total_count: 1, jobs: [job(11)] },
      [jobsEndpoint(1, 2)]: { total_count: 1, jobs: [job(12)] },
      [jobsEndpoint(2)]: { total_count: 1, jobs: [job(21)] },
      [jobsEndpoint(3)]: { total_count: 1, jobs: [job(31)] },
      [jobsEndpoint(4)]: { total_count: 1, jobs: [job(41, 'cancelled')] },
      [jobsEndpoint(5)]: { total_count: 1, jobs: [job(51)] },
      [jobsEndpoint(5, 2)]: { total_count: 1, jobs: [job(52, 'success')] },
    });
    expect(resolveFleetSubcommand('ci-failures')).toEqual({ module: './fleet-ci-failures.js', exportName: 'cmdFleetCiFailures' });
    expect(await cmdFleetCiFailures(['--repo', 'ashlrai/phantom', '--hours', '24', '--json'], { gh: fake.gh, now })).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.coverage).toMatchObject({ complete: true, runsFetched: 5, errors: [], truncations: [] });
    expect(report.groups).toHaveLength(3);
    expect(report.groups[0]).toMatchObject({ event: 'pull_request', conclusion: 'failure', latestRunCount: 2, historicalAttemptCount: 2, distinctPullRequests: 2, knownPullRequests: [1, 2] });
    expect(report.groups[0].evidence).toContainEqual(expect.objectContaining({ runId: 5, attempt: 1, latestAttempt: 2, headSha: 'sha5', jobUrl: expect.stringContaining('/job/51') }));
    expect(report.runs.find((r: { id: number }) => r.id === 5)).toMatchObject({ conclusion: 'success', attempt: 2 });
    expect(report.groups.find((g: { event: string }) => g.event === 'schedule')).toMatchObject({ latestRunCount: 1, distinctPullRequests: null });
    expect(report.groups.find((g: { conclusion: string }) => g.conclusion === 'cancelled')).toMatchObject({ latestRunCount: 1, distinctPullRequests: null });
    expect(fake.calls).toEqual([runsEndpoint(1), jobsEndpoint(1), jobsEndpoint(1, 2), jobsEndpoint(2), jobsEndpoint(3), jobsEndpoint(4), jobsEndpoint(5), jobsEndpoint(5, 2)].map(endpoint => ['api', endpoint]));
    expect(error).toBe('');
  });

  it('paginates runs and jobs, showing unknown PRs and all non-success states', async () => {
    const first = Array.from({ length: 25 }, (_, i) => run(i + 1, { run_attempt: 1 }));
    const responses: Record<string, unknown> = { [runsEndpoint(1)]: { total_count: 26, workflow_runs: first }, [runsEndpoint(2)]: { total_count: 26, workflow_runs: [run(26, { pull_requests: [] })] } };
    for (const r of first) responses[jobsEndpoint(r.id)] = { total_count: 0, jobs: [] };
    responses[jobsEndpoint(26)] = { total_count: 101, jobs: Array.from({ length: 100 }, (_, i) => job(i + 100, 'success')) };
    responses[jobsEndpoint(26, 1, 2)] = { total_count: 101, jobs: [job(201, 'timed_out')] };
    const fake = fakeGh(responses);
    expect(await cmdFleetCiFailures(['--json'], { gh: fake.gh, now })).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.coverage.runsFetched).toBe(26);
    expect(report.groups[0]).toMatchObject({ conclusion: 'timed_out', distinctPullRequests: null });
    expect(fake.calls).toContainEqual(['api', jobsEndpoint(26, 1, 2)]);
  });

  it('reports bounded truncation and API errors instead of a healthy empty report', async () => {
    const fake = fakeGh({ [runsEndpoint(1)]: { total_count: 51, workflow_runs: Array.from({ length: 25 }, (_, i) => run(i + 1, { run_attempt: i === 0 ? 4 : 1 })) }, [runsEndpoint(2)]: { total_count: 51, workflow_runs: Array.from({ length: 25 }, (_, i) => run(i + 26)) } });
    expect(await cmdFleetCiFailures([], { gh: fake.gh, now })).toBe(1);
    expect(output.join('\n')).toContain('PARTIAL');
    expect(output.join('\n')).toContain('workflow runs exceed 50');
    expect(output.join('\n')).toContain('attempts 1-1 omitted');
    expect(output.join('\n')).toContain('request failed');
    expect(output.join('\n')).not.toContain('private details');
    expect(fake.calls.length).toBeLessThanOrEqual(2 + 50 * 3 * 2);
  });

  it('caps job pagination and reports the latest example in text', async () => {
    const jobs = Array.from({ length: 100 }, (_, i) => job(i, 'failure'));
    const fake = fakeGh({ [runsEndpoint(1)]: { total_count: 1, workflow_runs: [run(1)] }, [jobsEndpoint(1)]: { total_count: 201, jobs }, [jobsEndpoint(1, 1, 2)]: { total_count: 201, jobs } });
    expect(await cmdFleetCiFailures([], { gh: fake.gh, now })).toBe(1);
    expect(output.join('\n')).toContain('jobs exceed 200');
    expect(output.join('\n')).toContain('1 latest run(s)');
    expect(output.join('\n')).toContain('/job/0');
    expect(fake.calls).toHaveLength(3);
  });

  it('reports skipped and incomplete jobs and validates arguments before reads', async () => {
    const fake = fakeGh({ [runsEndpoint(1)]: { total_count: 1, workflow_runs: [run(1)] }, [jobsEndpoint(1)]: { total_count: 2, jobs: [job(1, 'skipped'), job(2, null, { name: 'pending', status: 'in_progress' })] } });
    expect(await cmdFleetCiFailures(['--json'], { gh: fake.gh, now })).toBe(0);
    expect(JSON.parse(output[0]!).groups.map((g: { conclusion: string }) => g.conclusion).sort()).toEqual(['incomplete', 'skipped']);
    for (const args of [['--repo', '../x'], ['--repo', 'owner/repo?x'], ['--hours', '0'], ['--hours', '721'], ['--hours', '1.5'], ['--json', '--json']]) expect(await cmdFleetCiFailures(args, { gh: fake.gh, now })).toBe(2);
    expect(fake.calls).toHaveLength(2);
  });
});
