import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiEvidence } from '../src/cli/fleet-ci-evidence.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const sha = 'a'.repeat(40);
const secret = 'ghp_' + 'x'.repeat(36); // Synthetic token shape, never a real credential.
const job = { id: 42, run_id: 10, name: 'Tests', conclusion: 'failure', head_sha: sha,
  steps: [{ name: 'Install', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }] };
const ok = (stdout: string, patch: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false, ...patch });
const pages = (jobs: unknown[] = [job]) => JSON.stringify([{ total_count: jobs.length, jobs }]);
const args = ['--repo', 'ashlrai/phantom', '--run', '10', '--job', '42', '--json'];
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
    expect(options.maxStdoutBytes).toBe(calls.length ? 2 * 1024 * 1024 : 4 * 1024 * 1024);
    calls.push([...argv]);
    return responses[calls.length - 1] ?? ok('', { code: 1 });
  };
  return { gh, calls };
}
function result() { return JSON.parse(output[output.length - 1]!); }

describe('fleet ci-evidence', () => {
  it('reads only the selected run and job, returning scrubbed failure evidence', async () => {
    const f = fake([ok(pages()), ok(`2026-11-01 ##[group]Run tests\nnoise\n2026 ##[error] failed: \u001b[31m${secret}\u001b[0m\n`)]);
    expect(await cmdFleetCiEvidence(args, f)).toBe(0);
    expect(f.calls).toEqual([
      ['api', '--paginate', '--slurp', 'repos/ashlrai/phantom/actions/runs/10/jobs?filter=all&per_page=100'],
      ['api', 'repos/ashlrai/phantom/actions/jobs/42/logs'],
    ]);
    expect(result()).toMatchObject({ version: 1, repo: 'ashlrai/phantom', run: 10, job: 42,
      headSha: sha, jobName: 'Tests', conclusion: 'failure', failedSteps: ['Run tests'],
      source: { status: 'ok', truncated: false, outputTruncated: false } });
    expect(result().excerpts).toHaveLength(2);
    expect(output.join()).toContain('[REDACTED]');
    expect(output.join()).not.toContain(secret);
    expect(output.join()).not.toContain('\\u001b');
  });
  it('never reads a log when the job is absent or belongs to a different run', async () => {
    for (const jobs of [[], [{ ...job, run_id: 11 }], [job, job]]) {
      const f = fake([ok(pages(jobs))]);
      expect(await cmdFleetCiEvidence(args, f)).toBe(1);
      expect(f.calls).toHaveLength(1);
      expect(['job_not_found', 'job_invalid']).toContain(result().source.status);
    }
  });
  it('rejects incomplete or malformed job pages before reading logs', async () => {
    for (const response of [ok('[{"total_count":2,"jobs":[]}]'), ok('not json'), ok('', { truncated: true, code: null })]) {
      const f = fake([response]);
      expect(await cmdFleetCiEvidence(args, f)).toBe(1);
      expect(f.calls).toHaveLength(1);
      expect(['jobs_invalid', 'jobs_truncated']).toContain(result().source.status);
    }
  });
  it('recognizes later pages', async () => {
    const f = fake([ok(JSON.stringify([{ total_count: 2, jobs: [{ ...job, id: 41 }] }, { total_count: 2, jobs: [job] }])), ok('##[error] failed')]);
    expect(await cmdFleetCiEvidence(args, f)).toBe(0);
    expect(f.calls).toHaveLength(2);
  });
  it('reports unavailable or redirected logs without echoing stderr', async () => {
    for (const log of [ok('', { code: 1, stderr: secret }), ok(''), ok('https://example.invalid/signed'), ok('<html>expired</html>'), ok('', { timedOut: true })]) {
      const f = fake([ok(pages()), log]);
      expect(await cmdFleetCiEvidence(args, f)).toBe(1);
      expect(result().source.status).toBe('log_unavailable');
      expect(output.join() + errors.join()).not.toContain(secret);
    }
  });
  it('bounds noisy evidence, strips controls and scrubs before shortening lines', async () => {
    const log = Array.from({ length: 50 }, () => `error ${'z'.repeat(500)} token=${secret}`).join('\n');
    const f = fake([ok(pages([{ ...job, name: `\u001b[31m${secret}\u001b[0m` }])), ok(log)]);
    expect(await cmdFleetCiEvidence(args, f)).toBe(0);
    expect(result().source.outputTruncated).toBe(true);
    expect(result().excerpts).toHaveLength(20);
    expect(result().excerpts.every((line: string) => line.length <= 400)).toBe(true);
    expect(output.join()).not.toContain(secret);
    expect(output.join()).not.toContain('\\u001b');
  });
  it('marks truncated log reads non-success and discards the partial final line', async () => {
    const f = fake([ok(pages()), ok(`error first\nerror token=${secret.slice(0, 12)}`, { code: null, truncated: true })]);
    expect(await cmdFleetCiEvidence(args, f)).toBe(1);
    expect(result().source).toMatchObject({ status: 'log_truncated', truncated: true });
    expect(result().excerpts).toEqual(['error first']);
  });
  it('prints a short text block', async () => {
    const f = fake([ok(pages()), ok('##[error] compilation failed')]);
    expect(await cmdFleetCiEvidence(args.slice(0, -1), f)).toBe(0);
    expect(output.join('\n')).toContain('Failed steps: Run tests');
    expect(output.join('\n')).toContain('compilation failed');
  });
  it.each([
    ['--repo', 'ashlrai/phantom', '--run', '0', '--job', '42'],
    ['--repo', '../bad', '--run', '10', '--job', '42'],
    ['--repo', 'ashlrai/phantom', '--run', '9007199254740992', '--job', '42'],
    ['--repo', 'ashlrai/phantom', '--run', '-1', '--job', '42'],
    ['--repo', 'ashlrai/phantom', '--run', '1.1', '--job', '42'],
    ['--repo', 'ashlrai/phantom', '--run', '10'],
    [...args, '--job', '42'],
  ])('rejects bad arguments without gh: %j', async (...bad) => {
    const f = fake([]);
    expect(await cmdFleetCiEvidence(bad, f)).toBe(2);
    expect(f.calls).toHaveLength(0);
  });
});
