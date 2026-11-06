import { describe, expect, it } from 'vitest';
import { collectCiRepairPacket } from '../src/core/fleet/ci-repair-packet.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const repo = 'ashlrai/phantom', sha = 'a'.repeat(40), now = new Date('2026-11-01T06:00:00Z');
const fakeSecret = 'ghp_' + 'x'.repeat(36);
const run = (id = 10, attempt = 1) => ({ id, run_attempt: attempt, path: '.github/workflows/ci.yml', event: 'push', head_sha: sha, status: 'completed', conclusion: 'failure', created_at: '2026-11-01T05:00:00Z', updated_at: '2026-11-01T05:10:00Z', html_url: `https://github.com/${repo}/actions/runs/${id}` });
const job = (id = 42, name = 'Tests', url = `https://github.com/${repo}/actions/runs/10/job/${id}`, conclusion = 'failure') => ({ id, name, status: 'completed', conclusion, started_at: '2026-11-01T05:01:00Z', completed_at: '2026-11-01T05:02:00Z', html_url: url });
const ok = (stdout: string, patch: Partial<GitRunResult> = {}): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false, ...patch });
function fixture(options: { runs?: ReturnType<typeof run>[]; attempts?: Record<string, ReturnType<typeof job>[]>; evidence?: Record<string, unknown>; log?: GitRunResult; failGroups?: boolean } = {}) {
  const calls: string[][] = [], reads: string[][] = [];
  const runs = options.runs ?? [run()];
  const attempts = options.attempts ?? { '10:1': [job()] };
  const gh: CloudGh = async argv => {
    calls.push(argv);
    if (options.failGroups) return { ok: false, stdout: '', stderr: fakeSecret };
    const match = argv[1]!.match(/runs\/(\d+)\/attempts\/(\d+)\/jobs/);
    const rows = match ? (attempts[`${match[1]}:${match[2]}`] ?? []) : runs;
    return { ok: true, stdout: JSON.stringify(match ? { total_count: rows.length, jobs: rows } : { total_count: rows.length, workflow_runs: rows }), stderr: '' };
  };
  const runner: GitRunner = async (bin, argv, opts) => {
    expect(bin).toBe('gh'); expect(opts.timeoutMs).toBe(30_000);
    reads.push([...argv]);
    if (argv.includes('--slurp')) {
      const id = Number(argv.at(-1)!.match(/runs\/(\d+)\/jobs/)![1]);
      const distinct = new Map(Object.values(attempts).flat().filter(j => j.html_url.includes(`/runs/${id}/job/`)).map(j => [j.id, j]));
      const jobs = [...distinct.values()].map(j => ({ id: j.id, run_id: id, name: j.name, conclusion: j.conclusion, head_sha: sha, steps: [{ name: 'Run tests', conclusion: 'failure' }], ...options.evidence }));
      return ok(JSON.stringify([{ total_count: jobs.length, jobs }]));
    }
    return options.log ?? ok(`##[error] failure token=${fakeSecret}\n`);
  };
  return { gh, runner, calls, reads };
}
const packet = (f: ReturnType<typeof fixture>, limit = 3) => collectCiRepairPacket(repo, 24, limit, now, f);

describe('CI repair packet', () => {
  it('joins real grouped failures to exact job evidence and scrubs metadata and logs', async () => {
    const f = fixture({ attempts: { '10:1': [job(42, `Tests token=${fakeSecret}`)] } });
    const result = await packet(f);
    expect(result).toMatchObject({ version: 1, repo, complete: true, coverage: { complete: true }, items: [{ runId: 10, attempt: 1, latestAttempt: 1, headSha: sha, jobId: 42, unavailable: null, evidence: { failedSteps: ['Run tests'], source: { status: 'ok' } } }] });
    expect(JSON.stringify(result)).not.toContain(fakeSecret);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
    expect(f.reads).toEqual([['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/10/jobs?filter=all&per_page=100`], ['api', `repos/${repo}/actions/jobs/42/logs`]]);
  });
  it('preserves historical failures without reading their logs', async () => {
    const f = fixture({ runs: [run(10, 2)], attempts: { '10:1': [job()], '10:2': [job(43, 'Tests', undefined, 'success')] } });
    const result = await packet(f);
    expect(result.historical).toHaveLength(1); expect(result.items).toHaveLength(0); expect(result.noFailuresObserved).toBe(false); expect(result.complete).toBe(true); expect(f.reads).toHaveLength(0);
  });
  it.each(['https://github.com/other/phantom/actions/runs/10/job/42', `https://github.com/${repo}/actions/runs/11/job/42`, `https://github.com/${repo}/actions/runs/10/job/42?x=1`, `https://github.com/${repo}/actions/runs/10/job/0`])('rejects invalid job identity %s', async url => {
    const f = fixture({ attempts: { '10:1': [job(42, 'Tests', url)] } });
    const result = await packet(f);
    expect(result.items[0]?.unavailable).toBe('invalid_job_url'); expect(result.complete).toBe(false); expect(f.reads).toHaveLength(0);
  });
  it.each([[{ head_sha: 'b'.repeat(40) }, 'head_mismatch'], [{ name: 'Other' }, 'job_mismatch'], [{ run_id: 11 }, 'job_invalid']] as const)('rejects evidence with mismatched identity', async (evidence, reason) => {
    const f = fixture({ evidence }); const result = await packet(f);
    expect(result.items[0]?.unavailable).toBe(reason); expect(result.complete).toBe(false);
    if (reason !== 'job_invalid') expect(result.items[0]?.evidence).toBeNull();
  });
  it('reports truncated and unavailable evidence without leaking stderr', async () => {
    for (const log of [ok('error first\npartial', { truncated: true, code: null }), ok('', { code: 1, stderr: fakeSecret })]) {
      const f = fixture({ log }); const result = await packet(f);
      expect(result.complete).toBe(false); expect(['log_truncated', 'log_unavailable']).toContain(result.items[0]?.unavailable); expect(JSON.stringify(result)).not.toContain(fakeSecret);
    }
  });
  it('reports partial grouping and an empty complete interval distinctly', async () => {
    const partial = await packet(fixture({ failGroups: true }));
    expect(partial).toMatchObject({ complete: false, noFailuresObserved: false, coverage: { complete: false } });
    const empty = await packet(fixture({ runs: [] }));
    expect(empty).toMatchObject({ complete: true, noFailuresObserved: true, items: [] });
  });
  it('respects group and evidence caps and deduplicates identical jobs', async () => {
    const many = Array.from({ length: 12 }, (_, i) => job(42 + i, 'Tests'));
    const f = fixture({ attempts: { '10:1': [...many, many[0]!, job(100, 'Zebra')] } });
    const result = await packet(f, 1);
    expect(result.selectedGroups).toHaveLength(1); expect(result.items).toHaveLength(10);
    expect(result.omitted).toEqual({ groups: 1, evidence: 2, duplicateJobs: 1, nonCompletedGroups: 0 }); expect(f.reads).toHaveLength(20);
  });
  it('limits concurrent evidence reads to two', async () => {
    const f = fixture({ attempts: { '10:1': Array.from({ length: 6 }, (_, i) => job(42 + i)) } });
    let active = 0, peak = 0;
    const runner: GitRunner = async (...args) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      try { return await f.runner(...args); } finally { active--; }
    };
    const result = await packet({ ...f, runner });
    expect(result.complete).toBe(true); expect(peak).toBe(2);
  });
  it('rejects conflicting reuse of a job id without reading its logs', async () => {
    const f = fixture({ attempts: { '10:1': [job(42, 'Tests'), job(42, 'Other')] } });
    const result = await packet(f);
    expect(result.items[0]?.unavailable).toBe('ambiguous_job_identity'); expect(f.reads).toHaveLength(0);
  });
});
