import { describe, expect, it } from 'vitest';
import { cmdFleetCiStepCost } from '../src/cli/fleet-ci-step-cost.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const base = 'repos/ashlrai/phantom/actions/runs/42';
const jobsUrl = (page = 1) => `${base}/attempts/2/jobs?per_page=100&page=${page}`;
const time = (minute: number, second = 0) => `2026-11-01T06:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
const run = { id: 42, run_attempt: 2, head_sha: 'a'.repeat(40), name: 'CI', event: 'schedule', status: 'completed', run_started_at: time(0), updated_at: time(10) };
const step = (number: number, name: string, start: number, end: number) => ({ number, name, status: 'completed', conclusion: 'success', started_at: time(start), completed_at: time(end) });
const job = (id: number, steps: unknown[], overrides: Record<string, unknown> = {}) => ({ id, name: `Job ${id}`, status: 'completed', conclusion: 'success', created_at: time(0), started_at: time(1), completed_at: time(10), steps, ...overrides });
const args = ['--repo', 'ashlrai/phantom', '--run', '42', '--json'];
function fixture(responses: Record<string, unknown>) {
  const calls: string[][] = [], output: string[] = [], errors: string[] = [];
  const gh: CloudGh = async argv => {
    calls.push(argv);
    const value = responses[argv[1]!];
    if (value === undefined) return { ok: false, stdout: '', stderr: 'private error' };
    return { ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
  };
  return { calls, output, errors, deps: { gh, now: () => new Date('2026-11-01T07:00:00Z'), output: (line: string) => output.push(line), error: (line: string) => errors.push(line) } };
}

describe('fleet ci-step-cost', () => {
  it('ranks slow steps across parallel jobs without adding their elapsed times', async () => {
    const f = fixture({ [base]: run, [jobsUrl()]: { total_count: 2, jobs: [job(11, [step(1, 'Setup', 1, 9), step(2, 'Test', 9, 10)]), job(12, [step(1, 'Build', 1, 8)])] } });
    expect(resolveFleetSubcommand('ci-step-cost')).toEqual({ module: './fleet-ci-step-cost.js', exportName: 'cmdFleetCiStepCost' });
    expect(await cmdFleetCiStepCost(args, f.deps)).toBe(0);
    const report = JSON.parse(f.output[0]!);
    expect(report).toMatchObject({ v: 1, runId: 42, attempt: 2, headSha: 'a'.repeat(40), workflow: 'CI', event: 'schedule', elapsedSeconds: 600, complete: true, generatedAt: '2026-11-01T07:00:00.000Z', runUrl: 'https://github.com/ashlrai/phantom/actions/runs/42' });
    expect(report.topSteps.map((s: { name: string; wallSeconds: number }) => [s.name, s.wallSeconds])).toEqual([['Setup', 480], ['Build', 420], ['Test', 60]]);
    expect(report.jobs[0]).toMatchObject({ id: 11, queueSeconds: 60, executionSeconds: 540 });
    expect(f.calls).toEqual([['api', base], ['api', jobsUrl()]]);
  });

  it('preserves unknowns for running and invalid timestamps and zero only for skipped steps', async () => {
    const f = fixture({ [base]: { ...run, status: 'in_progress' }, [jobsUrl()]: { total_count: 2, jobs: [job(11, [step(1, 'Done', 1, 2), { number: 2, name: 'Skip', status: 'completed', conclusion: 'skipped', started_at: null, completed_at: null }, { number: 3, name: 'Bad', status: 'completed', conclusion: 'success', started_at: time(5), completed_at: time(3) }]), job(12, [{ number: 1, name: 'Running', status: 'in_progress', conclusion: null, started_at: time(1), completed_at: null }], { status: 'in_progress', conclusion: null, completed_at: null, started_at: null })] } });
    expect(await cmdFleetCiStepCost(args, f.deps)).toBe(1);
    const report = JSON.parse(f.output[0]!);
    expect(report).toMatchObject({ complete: false, elapsedSeconds: null });
    expect(report.jobs[0].steps.map((s: { wallSeconds: number | null }) => s.wallSeconds)).toEqual([60, 0, null]);
    expect(report.jobs[1]).toMatchObject({ queueSeconds: null, executionSeconds: null, steps: [{ wallSeconds: null }] });
    expect(report.topSteps.map((s: { name: string }) => s.name)).toEqual(['Done', 'Skip']);
  });

  it('rejects unsafe or missing arguments before gh', async () => {
    const f = fixture({});
    for (const invalid of [[], ['--repo', 'ashlrai/phantom', '--run', '0'], ['--repo', 'ashlrai/phantom', '--run', '1.5'], ['--repo', 'ashlrai/phantom', '--run', '9007199254740992'], ['--repo', 'https://github.com/a/b', '--run', '42'], ['--repo', 'a/..', '--run', '42'], ['--repo', 'a/b', '--run', 'https://example.com'], [...args, '--json']]) expect(await cmdFleetCiStepCost(invalid, f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });

  it('marks failed, malformed and truncated reads incomplete without exposing raw data', async () => {
    for (const response of [undefined, '{bad json', { id: 99, run_attempt: 1 }]) {
      const f = fixture({ [base]: response });
      expect(await cmdFleetCiStepCost(args, f.deps)).toBe(1);
      expect(JSON.parse(f.output[0]!)).toMatchObject({ complete: false, jobs: [], issues: ['run metadata unavailable or malformed'] });
      expect(f.output.join()).not.toContain('private error');
    }
    for (const response of [undefined, '{', { total_count: 1, jobs: 'bad' }, { total_count: 2, jobs: [job(11, [])] }, 'x'.repeat(4 * 1024 * 1024 + 1)]) {
      const f = fixture({ [base]: run, [jobsUrl()]: response });
      expect(await cmdFleetCiStepCost(args, f.deps)).toBe(1);
      expect(JSON.parse(f.output[0]!).complete).toBe(false);
    }
  });

  it('bounds pagination and steps, and handles changed counts and duplicate jobs', async () => {
    const many = Array.from({ length: 100 }, (_, i) => job(i + 1, []));
    const paged = fixture({ [base]: run, [jobsUrl()]: { total_count: 101, jobs: many }, [jobsUrl(2)]: { total_count: 101, jobs: [job(101, [])] } });
    expect(await cmdFleetCiStepCost(args, paged.deps)).toBe(0);
    expect(JSON.parse(paged.output[0]!).jobs).toHaveLength(101);
    const f = fixture({ [base]: run, [jobsUrl()]: { total_count: 201, jobs: many }, [jobsUrl(2)]: { total_count: 201, jobs: many.map(j => ({ ...j, id: j.id + 100 })) } });
    expect(await cmdFleetCiStepCost(args, f.deps)).toBe(1);
    expect(JSON.parse(f.output[0]!).issues).toContain('jobs incomplete: observed 200 of 201');
    expect(f.calls).toHaveLength(3);
    const g = fixture({ [base]: run, [jobsUrl()]: { total_count: 2, jobs: [job(1, Array.from({ length: 101 }, (_, i) => step(i + 1, 'x', 1, 2))), job(1, [])] } });
    expect(await cmdFleetCiStepCost(args, g.deps)).toBe(1);
    expect(JSON.parse(g.output[0]!).issues).toEqual(expect.arrayContaining(['job 1 exceeds 100 steps', 'malformed or duplicate job']));
  });

  it('sanitizes remote strings and renders grouped text with the parallelism caveat', async () => {
    const token = `ghp_${'x'.repeat(36)}`;
    const f = fixture({ [base]: { ...run, name: `CI\u001b[31m\nworkflow ${token}` }, [jobsUrl()]: { total_count: 1, jobs: [job(11, [step(1, 'Setup\nline', 1, 9)])] } });
    expect(await cmdFleetCiStepCost(args.slice(0, -1), f.deps)).toBe(0);
    expect(f.output.join('\n')).toContain('job 11 Job 11: queue 60s, execution 540s');
    expect(f.output.join('\n')).toContain('step 1 Setup line: 480s');
    expect(f.output.join('\n')).toContain('not run elapsed time or billed minutes');
    expect(f.output.join('\n')).not.toContain('\u001b');
    expect(f.output.join('\n')).not.toContain(token);
    expect(f.output.join('\n')).toContain('[REDACTED]');
  });

  it('does not normalize invalid calendar dates into valid durations', async () => {
    const bad = { ...step(1, 'Invalid date', 1, 2), started_at: '2026-02-30T06:01:00Z' };
    const f = fixture({ [base]: run, [jobsUrl()]: { total_count: 1, jobs: [job(1, [bad])] } });
    expect(await cmdFleetCiStepCost(args, f.deps)).toBe(1);
    expect(JSON.parse(f.output[0]!).jobs[0].steps[0].wallSeconds).toBeNull();
  });
});
