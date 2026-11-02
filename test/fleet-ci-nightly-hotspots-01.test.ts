import { describe, expect, it, vi } from 'vitest';
import { cmdFleetCiNightly } from '../src/cli/fleet-ci-nightly.js';
import { readCiNightly } from '../src/core/fleet/ci-nightly-hotspots.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const time = (minute: number) => `2026-10-30T00:${String(minute).padStart(2, '0')}:00Z`;
const run = (id: number, attempt = 1) => ({ id, run_attempt: attempt, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: attempt === 1 ? 'failure' : 'success', run_started_at: time(0), updated_at: time(10) });
const job = (id: number, name: string, labels: string[], attempt = 1) => ({
  id, run_id: 1, run_attempt: attempt, name, labels, status: 'completed', conclusion: 'success', runner_id: 1,
  created_at: time(0), started_at: time(2), completed_at: time(8),
  steps: [{ name: 'Tests', number: 1, status: 'completed', conclusion: 'success', started_at: time(2), completed_at: time(7) }],
});
const fixture = () => {
  const calls: string[][] = [];
  const skipped = Array.from({ length: 96 }, (_, i) => ({ ...job(100 + i, `skipped ${i}`, ['ubuntu']), conclusion: 'skipped', runner_id: null, steps: [] }));
  const first = [job(1, 'parallel A', ['ubuntu']), job(2, 'parallel B', ['ubuntu']),
    { ...job(3, 'missing timing', ['ubuntu']), completed_at: null },
    { ...job(4, 'Mac exhaustive (1/4)', ['macos-15']), conclusion: 'failure' }, ...skipped,
    { ...job(5, 'cancelled', ['ubuntu']), conclusion: 'cancelled', runner_id: null, steps: [] }];
  const gh: CloudGh = async args => {
    calls.push(args);
    const endpoint = args[1]!;
    let value: unknown;
    if (endpoint.includes('actions/runs?')) {
      const page = endpoint.endsWith('page=1') ? 1 : 2;
      value = { total_count: 11, workflow_runs: page === 1 ? Array.from({ length: 10 }, (_, i) => run(i + 1, i === 0 ? 2 : 1)) : [run(11)] };
    } else {
      const match = /runs\/(\d+)\/attempts\/(\d+)(\/jobs)?/.exec(endpoint)!;
      const id = Number(match[1]), attempt = Number(match[2]);
      if (!match[3]) value = run(id, attempt);
      else {
        const rows = id !== 1 ? [] : attempt === 1 ? first : [job(6, 'Mac exhaustive (1/4)', ['macos-15'], 2), job(7, 'parallel A', ['macos-14'], 2)];
        const page = endpoint.endsWith('page=2') ? 2 : 1;
        value = { total_count: rows.length, jobs: rows.slice((page - 1) * 100, page * 100) };
      }
    }
    return { ok: true, stdout: JSON.stringify(value), stderr: '' };
  };
  return { gh, calls };
};

describe('scheduled CI evidence', () => {
  it('pages attempts and jobs, separates wall, queue, runner time and cohorts', async () => {
    const { gh, calls } = fixture();
    const report = await readCiNightly('ashlrai/phantom', gh);
    expect(report.errors).toEqual([]);
    expect(report.listing).toEqual({ total: 11, pages: 2, complete: true });
    const first = report.runs.find(r => r.id === 1 && r.attempt === 1)!;
    expect(first.jobsComplete).toBe(true);
    expect(first.jobPages).toBe(2);
    expect(first.wallMs).toBe(600_000);
    // Three measured jobs ran in parallel for six minutes apiece.
    expect(first.observedRunnerMinutes).toBe(18);
    expect(first.jobs[0]).toMatchObject({ executionMs: 360_000, queueMs: 120_000, slowestSteps: [{ durationMs: 300_000, url: expect.stringContaining('#step:1:1') }] });
    expect(first.jobs.find(j => j.name === 'missing timing')?.executionMs).toBeNull();
    expect(first.jobs.find(j => j.name === 'cancelled')?.queueMs).toBeNull();
    expect(first.conclusion).toBe('failure');
    expect(report.runs.find(r => r.id === 1 && r.attempt === 2)?.attempt).toBe(2);
    expect(report.cohorts.filter(c => c.job === 'Mac exhaustive (1/4)')).toHaveLength(2);
    expect(report.cohorts.filter(c => c.job === 'parallel A')).toHaveLength(2);
    expect(report.cohorts.find(c => c.job === 'cancelled')?.cancelled).toBe(1);
    expect(report.cohorts.find(c => c.job === 'Mac exhaustive (1/4)' && c.failures === 1)).toBeDefined();
    expect(calls.every(args => args.length === 2 && args[0] === 'api' && !/logs|annotations/.test(args[1]!))).toBe(true);
  });

  it('renders JSON and text through the convention handler', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetCiNightly(['--repo', 'ashlrai/phantom', '--json'], fixture())).toBe(0);
      const report = JSON.parse(String(log.mock.calls[0]![0]));
      expect(report.runs[0].observedRunnerMinutes).toBe(18);
      log.mockClear();
      expect(await cmdFleetCiNightly(['--repo', 'ashlrai/phantom'], fixture())).toBe(0);
      const text = log.mock.calls.map(c => c.join(' ')).join('\n');
      expect(text).toContain('owner review candidates');
      expect(text).toContain('#step:1:1');
      expect(text).toContain('rotation slice unknown');
    } finally { log.mockRestore(); }
  });

  it('returns no evidence for an empty complete listing and fails closed on reads', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const empty: CloudGh = async () => ({ ok: true, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }), stderr: '' });
    const failure: CloudGh = async () => ({ ok: false, stdout: '', stderr: 'private detail' });
    try {
      expect(await cmdFleetCiNightly(['--repo', 'ashlrai/phantom', '--json'], { gh: empty })).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0])).evidence).toBe('none');
      log.mockClear();
      expect(await cmdFleetCiNightly(['--repo', 'ashlrai/phantom', '--json'], { gh: failure })).toBe(1);
      const report = JSON.parse(String(log.mock.calls[0]![0]));
      expect(report.evidence).toBe('unknown');
      expect(report.errors).toHaveLength(1);
      expect(JSON.stringify(report)).not.toContain('private detail');
    } finally { log.mockRestore(); }
  });

  it('exposes bounded history and failed jobs reads without reporting a complete capture', async () => {
    const base = fixture().gh;
    const broken: CloudGh = async args => {
      if (args[1]?.includes('/1/attempts/1/jobs')) return { ok: false, stdout: '', stderr: '' };
      if (args[1]?.includes('actions/runs?')) {
        const response = await base(args);
        const page = JSON.parse(response.stdout);
        page.total_count = 30;
        if (args[1].endsWith('page=2')) page.workflow_runs = Array.from({ length: 10 }, (_, i) => run(i + 11));
        return { ...response, stdout: JSON.stringify(page) };
      }
      return base(args);
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetCiNightly(['--repo', 'ashlrai/phantom', '--json'], { gh: broken })).toBe(1);
      const result = JSON.parse(String(log.mock.calls[0]![0]));
      expect(result.listing).toEqual({ total: 30, pages: 2, complete: false });
      expect(result.errors.some((error: string) => error.includes('/1/attempts/1/jobs'))).toBe(true);
      expect(result.runs.find((r: { id: number; attempt: number }) => r.id === 1 && r.attempt === 1)).toMatchObject({ jobsComplete: false, jobsTotal: null, observedRunnerMinutes: null });
    } finally { log.mockRestore(); }
  });

});
