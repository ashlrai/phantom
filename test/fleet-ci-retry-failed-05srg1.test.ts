import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiRetryFailed } from '../src/cli/fleet-ci-retry-failed.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const sha = 'a'.repeat(40);
const secret = 'ghp_' + 'x'.repeat(36); // Synthetic token shape, never a real credential.
const meta = (patch: Record<string, unknown> = {}) => JSON.stringify({
  id: 10, run_attempt: 2, head_sha: sha, status: 'completed', conclusion: 'failure',
  repository: { full_name: 'ashlrai/phantom' }, ...patch,
});
const job = (id: number, name: string, conclusion: string | null, patch: Record<string, unknown> = {}) => ({
  id, run_id: 10, run_attempt: 2, name, status: 'completed', conclusion, head_sha: sha, ...patch,
});
const jobs = (rows: unknown[]) => JSON.stringify([{ total_count: rows.length, jobs: rows }]);
const mixed = [job(1, 'build', 'success'), job(2, 'test', 'failure'), job(3, 'lint', 'timed_out'), job(4, 'docs', 'skipped')];
const ok = (stdout: string, patch: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false, ...patch });
const args = ['--repo', 'ashlrai/phantom', '--run', '10', '--json'];
let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((value) => { errors.push(String(value)); return true; });
});
afterEach(() => vi.restoreAllMocks());

function fake(responses: GitRunResult[]): { gh: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GitRunner = async (bin, argv, options) => {
    expect(bin).toBe('gh');
    expect(options.timeoutMs).toBe(30_000);
    calls.push([...argv]);
    return responses[calls.length - 1] ?? ok('', { code: 1 });
  };
  return { gh, calls };
}
const result = () => JSON.parse(output[output.length - 1]!);
const mutations = (calls: string[][]) => calls.filter((argv) => argv[0] === 'run' && argv[1] === 'rerun');

describe('fleet ci-retry-failed', () => {
  it('--apply submits exactly one --failed rerun for the same attempt, never a full rerun', async () => {
    const f = fake([ok(meta()), ok(jobs(mixed)), ok(meta()), ok('rerun requested')]);
    expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(0);
    expect(f.calls).toEqual([
      ['api', 'repos/ashlrai/phantom/actions/runs/10'],
      ['api', '--paginate', '--slurp', 'repos/ashlrai/phantom/actions/runs/10/jobs?filter=latest_attempt&per_page=100'],
      ['api', 'repos/ashlrai/phantom/actions/runs/10'],
      ['run', 'rerun', '10', '--failed', '--repo', 'ashlrai/phantom'],
    ]);
    expect(mutations(f.calls)).toHaveLength(1);
    expect(mutations(f.calls)[0]).toContain('--failed');
    expect(result()).toMatchObject({ version: 1, repo: 'ashlrai/phantom', run: 10, apply: true,
      outcome: 'submitted', reason: 'failed_jobs', attempt: 2, headSha: sha,
      runStatus: 'completed', conclusion: 'failure',
      preserved: { count: 1, names: ['build'] },
      retry: { count: 2, names: ['test', 'lint'] },
      untouched: { count: 1, names: ['docs'] },
      mutation: { invoked: true, accepted: true, detail: null } });
  });
  it('default plans without any mutation', async () => {
    const f = fake([ok(meta()), ok(jobs(mixed))]);
    expect(await cmdFleetCiRetryFailed(args, f)).toBe(0);
    expect(f.calls).toHaveLength(2);
    expect(mutations(f.calls)).toHaveLength(0);
    expect(result()).toMatchObject({ outcome: 'planned', apply: false, mutation: { invoked: false, accepted: false } });
  });
  it('refuses a run that is still in progress before reading jobs', async () => {
    const f = fake([ok(meta({ status: 'in_progress', conclusion: null }))]);
    expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(result()).toMatchObject({ outcome: 'refused', reason: 'run_not_completed', mutation: { invoked: false } });
  });
  it('is a no-op on a run whose jobs all succeeded, even with --apply', async () => {
    const f = fake([ok(meta({ conclusion: 'success' })), ok(jobs([job(1, 'build', 'success'), job(2, 'test', 'success')]))]);
    expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(0);
    expect(mutations(f.calls)).toHaveLength(0);
    expect(result()).toMatchObject({ outcome: 'no-op', reason: 'no_failed_jobs', preserved: { count: 2 } });
  });
  it('refuses a completed run with an unknown conclusion', async () => {
    const f = fake([ok(meta({ conclusion: null }))]);
    expect(await cmdFleetCiRetryFailed(args, f)).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(result()).toMatchObject({ outcome: 'refused', reason: 'unknown_conclusion' });
  });
  it('reports unavailable when the jobs page is missing, truncated or malformed', async () => {
    for (const [response, reason] of [
      [ok('', { code: 1, stderr: secret }), 'jobs_unavailable'],
      [ok('', { code: null, truncated: true }), 'jobs_truncated'],
      [ok('not json'), 'jobs_invalid'],
      [ok(jobs([{ ...job(9, 'other', 'failure'), run_id: 11 }])), 'jobs_mismatch'],
    ] as const) {
      const f = fake([ok(meta()), response]);
      expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(1);
      expect(result()).toMatchObject({ outcome: 'unavailable', reason, mutation: { invoked: false } });
      expect(mutations(f.calls)).toHaveLength(0);
      expect(output.join() + errors.join()).not.toContain(secret);
      output = []; errors = [];
    }
  });
  it('reports unavailable when run metadata is missing, truncated, malformed or mismatched', async () => {
    for (const [response, reason] of [
      [ok('', { code: 1, stderr: secret }), 'run_metadata_unavailable'],
      [ok('', { code: null, truncated: true }), 'run_metadata_truncated'],
      [ok('not json'), 'run_metadata_invalid'],
      [ok(meta({ id: 11 })), 'run_metadata_mismatch'],
      [ok(meta({ repository: { full_name: 'other/repo' } })), 'run_metadata_mismatch'],
    ] as const) {
      const f = fake([response]);
      expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(1);
      expect(result()).toMatchObject({ outcome: 'unavailable', reason, mutation: { invoked: false } });
      expect(f.calls).toHaveLength(1);
      output = []; errors = [];
    }
  });
  it('refuses when the attempt advances between plan and apply', async () => {
    const f = fake([ok(meta()), ok(jobs(mixed)), ok(meta({ run_attempt: 3 }))]);
    expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(1);
    expect(f.calls).toHaveLength(3);
    expect(mutations(f.calls)).toHaveLength(0);
    expect(result()).toMatchObject({ outcome: 'refused', reason: 'changed_before_apply', attempt: 2, mutation: { invoked: false } });
  });
  it('refuses when the re-read head SHA or completion state changed', async () => {
    for (const reread of [meta({ head_sha: 'b'.repeat(40) }), meta({ status: 'in_progress' }), meta({ conclusion: 'cancelled' })]) {
      const f = fake([ok(meta()), ok(jobs(mixed)), ok(reread)]);
      expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(1);
      expect(result().reason).toBe('changed_before_apply');
      expect(mutations(f.calls)).toHaveLength(0);
      output = []; errors = [];
    }
    const f = fake([ok(meta()), ok(jobs(mixed)), ok('', { code: 1 })]);
    expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(1);
    expect(result().reason).toBe('revalidate_failed');
  });
  it('reports gh rejecting the rerun, scrubbing stderr and claiming acceptance only', async () => {
    const f = fake([ok(meta()), ok(jobs(mixed)), ok(meta()), ok('', { code: 1, stderr: `refused ${secret}` })]);
    expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(1);
    expect(mutations(f.calls)).toHaveLength(1);
    expect(result()).toMatchObject({ outcome: 'refused', reason: 'rerun_rejected', mutation: { invoked: true, accepted: false } });
    expect(output.join() + errors.join()).not.toContain(secret);
    expect(result().mutation.detail).toContain('[REDACTED]');
  });
  it('scrubs secret-shaped job names from the report', async () => {
    const f = fake([ok(meta()), ok(jobs([job(1, `test ${secret}`, 'failure')])), ok(meta()), ok('done')]);
    expect(await cmdFleetCiRetryFailed([...args, '--apply'], f)).toBe(0);
    expect(output.join()).not.toContain(secret);
    expect(output.join()).toContain('[REDACTED]');
  });
  it.each([
    ['--repo', '../bad', '--run', '10'],
    ['--repo', 'ashlrai/phantom'],
    ['--repo', 'ashlrai/phantom', '--run', '0'],
    ['--repo', 'ashlrai/phantom', '--run', '9007199254740992'],
    ['--repo', 'ashlrai/phantom', '--run', 'x'],
    ['--repo', 'ashlrai/phantom', '--run', '-1'],
    ['--run', '10'],
    [...args, '--run', '10'],
    [...args, '--bogus'],
    [...args, '--apply', '--apply', '--json'],
    ['--repo'],
  ])('rejects bad arguments without gh: %j', async (...bad) => {
    const f = fake([]);
    expect(await cmdFleetCiRetryFailed(bad, f)).toBe(2);
    expect(f.calls).toHaveLength(0);
  });
});
