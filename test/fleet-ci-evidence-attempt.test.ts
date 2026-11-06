import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiEvidence } from '../src/cli/fleet-ci-evidence.js';
import { readCiEvidence } from '../src/core/fleet/ci-evidence.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const repo = 'ashlrai/phantom';
const sha = 'a'.repeat(40);
const metadata = { id: 10, run_attempt: 1, head_sha: sha, repository: { full_name: repo } };
const oldJob = { id: 42, run_id: 10, run_attempt: 1, head_sha: sha, name: 'Tests', conclusion: 'failure',
  steps: [{ name: 'Run tests', conclusion: 'failure' }] };
const newJob = { ...oldJob, id: 43, run_attempt: 2, conclusion: 'success' };
const ok = (value: unknown, patch: Partial<GitRunResult> = {}): GitRunResult => ({
  code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '',
  timedOut: false, truncated: false, missing: false, ...patch,
});
const pages = (jobs: unknown[]) => [{ total_count: jobs.length, jobs }];
const args = ['--repo', repo, '--run', '10', '--attempt', '1', '--job', '42', '--json'];
const attemptPath = `repos/${repo}/actions/runs/10/attempts/1`;
let output: string[];

beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

function fake(responses: GitRunResult[]) {
  const calls: string[][] = [];
  const gh: GitRunner = async (bin, argv, options) => {
    expect(bin).toBe('gh');
    expect(options.timeoutMs).toBe(30_000);
    expect(options.maxStdoutBytes).toBe(argv[1]?.includes('/logs') ? 2 * 1024 * 1024 : 4 * 1024 * 1024);
    calls.push([...argv]);
    return responses[calls.length - 1] ?? ok('', { code: 1 });
  };
  return { gh, calls };
}
const parsed = () => JSON.parse(output.at(-1)!);

describe('attempt-scoped CI evidence', () => {
  it('selects an older failed attempt instead of the newer successful job and exposes provenance in JSON', async () => {
    const f = fake([ok(metadata), ok(pages([oldJob])), ok('##[error] old attempt failed')]);
    expect(await cmdFleetCiEvidence(args, f)).toBe(0);
    expect(f.calls).toEqual([
      ['api', attemptPath],
      ['api', '--paginate', '--slurp', `${attemptPath}/jobs?per_page=100`],
      ['api', `repos/${repo}/actions/jobs/42/logs`],
    ]);
    expect(parsed()).toMatchObject({ attempt: { requested: 1, observed: 1 }, headSha: sha,
      job: 42, conclusion: 'failure', excerpts: ['##[error] old attempt failed'] });
    const newer = fake([ok({ ...metadata, run_attempt: 2 }), ok(pages([newJob])), ok('success')]);
    const newerEvidence = await readCiEvidence(repo, 10, 43, newer.gh, 2);
    expect(newerEvidence).toMatchObject({ attempt: { requested: 2, observed: 2 }, conclusion: 'success', excerpts: [] });
  });

  it('rejects a newer attempt job absent from the requested attempt without reading its log', async () => {
    const f = fake([ok(metadata), ok(pages([oldJob]))]);
    expect(await cmdFleetCiEvidence(args.map((v) => v === '42' ? String(newJob.id) : v), f)).toBe(1);
    expect(parsed()).toMatchObject({ attempt: { requested: 1, observed: 1 }, source: { status: 'job_not_found' } });
    expect(f.calls).toHaveLength(2);
  });

  it.each([
    { ...oldJob, run_id: 11 },
    { ...oldJob, run_attempt: 2 },
    { ...oldJob, head_sha: 'b'.repeat(40) },
  ])('rejects selected job with mismatched run, attempt or SHA: %j', async (job) => {
    const f = fake([ok(metadata), ok(pages([job]))]);
    expect((await readCiEvidence(repo, 10, 42, f.gh, 1)).source.status).toBe('job_invalid');
    expect(f.calls).toHaveLength(2);
  });

  it.each([
    [{ ...metadata, id: 11 }, 'attempt_mismatch', 1],
    [{ ...metadata, run_attempt: 2 }, 'attempt_mismatch', 2],
    [{ ...metadata, repository: { full_name: 'another/repo' } }, 'attempt_mismatch', 1],
    [{ ...metadata, head_sha: 'bad' }, 'attempt_invalid', null],
    [{ ...metadata, repository: {} }, 'attempt_invalid', null],
    ['{bad', 'attempt_invalid', null],
  ])('stops on invalid or mismatched metadata: %j', async (value, status, observed) => {
    const f = fake([ok(value)]);
    expect(await cmdFleetCiEvidence(args, f)).toBe(1);
    expect(parsed()).toMatchObject({ attempt: { requested: 1, observed }, source: { status } });
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ok('', { code: 1 }), ok('', { timedOut: true }), ok('', { missing: true }),
  ])('reports unavailable metadata without fetching jobs or logs', async (response) => {
    const f = fake([response]);
    expect((await readCiEvidence(repo, 10, 42, f.gh, 1)).source.status).toBe('attempt_unavailable');
    expect(f.calls).toHaveLength(1);
  });

  it('reports truncated metadata without fetching jobs or logs', async () => {
    const f = fake([ok(metadata, { truncated: true })]);
    expect((await readCiEvidence(repo, 10, 42, f.gh, 1)).source).toMatchObject({ status: 'attempt_invalid', truncated: true });
    expect(f.calls).toHaveLength(1);
  });

  it('prints requested and observed attempt provenance in text', async () => {
    const f = fake([ok(metadata), ok(pages([oldJob])), ok('error failed')]);
    expect(await cmdFleetCiEvidence(args.slice(0, -1), f)).toBe(0);
    expect(output.join('\n')).toContain('Attempt requested: 1; observed: 1');
  });

  it.each(['0', '-1', '1.1', '9007199254740992', 'NaN', '', '--json'])('rejects malformed attempt %j before I/O', async (value) => {
    const f = fake([]);
    expect(await cmdFleetCiEvidence([...args.slice(0, 4), '--attempt', value, '--job', '42'], f)).toBe(2);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    [...args, '--attempt', '1'], [...args, '--json'], [...args, '--run', '10'],
    ['--repo', repo, '--run', '10', '--job', '42', '--attempt'],
  ])('rejects duplicate or missing flags before I/O: %j', async (...bad) => {
    const f = fake([]);
    expect(await cmdFleetCiEvidence(bad, f)).toBe(2);
    expect(f.calls).toHaveLength(0);
  });

  it('accepts the largest safe attempt integer and rejects unsafe direct calls without I/O', async () => {
    const f = fake([ok('', { code: 1 })]);
    expect(await cmdFleetCiEvidence(args.map((v, i) => i === 5 ? String(Number.MAX_SAFE_INTEGER) : v), f)).toBe(1);
    expect(f.calls[0]).toEqual(['api', `repos/${repo}/actions/runs/10/attempts/${Number.MAX_SAFE_INTEGER}`]);
    const invalid = fake([]);
    expect((await readCiEvidence(repo, 10, 42, invalid.gh, Number.MAX_SAFE_INTEGER + 1)).source.status).toBe('attempt_invalid');
    expect(invalid.calls).toHaveLength(0);
  });

  it('preserves the existing runner argument and legacy request sequence', async () => {
    const f = fake([ok(pages([oldJob, newJob])), ok('error legacy')]);
    const evidence = await readCiEvidence(repo, 10, 42, f.gh);
    expect(evidence.source.status).toBe('ok');
    expect(evidence).not.toHaveProperty('attempt');
    expect(f.calls).toEqual([
      ['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/10/jobs?filter=all&per_page=100`],
      ['api', `repos/${repo}/actions/jobs/42/logs`],
    ]);
  });
});
