import { describe, expect, it } from 'vitest';
import { classifyFailedJobs, readCiRunFacts, summarizeCiRuns, type CiRunLite } from '../src/core/fleet/ci-run-facts.js';
const nowMs = Date.parse('2026-11-01T12:00:00Z');
const run = (id: number, extra: Partial<CiRunLite> = {}): CiRunLite => ({ id, name: 'CI', event: 'pull_request', headBranch: 'topic', prNumber: 1, status: 'completed', conclusion: 'failure', createdAt: new Date(nowMs - id * 1000).toISOString(), htmlUrl: '', ...extra });
const job = (name: string, steps: string[], conclusion = 'failure') => ({ name, conclusion, steps: steps.map(name => ({ name, conclusion: 'failure' })) });
describe('CI run facts', () => {
  it('classifies bind-only, consequential gate, mixed, absent and opaque failures', () => {
    const bind = job('Test', ['Bind candidate source']);
    const gate = job('Merge Gate', ['Require selected CI lane']);
    expect(classifyFailedJobs([bind])).toBe('bind-artifact');
    expect(classifyFailedJobs([gate])).toBe('bind-artifact');
    expect(classifyFailedJobs([bind, gate])).toBe('bind-artifact');
    expect(classifyFailedJobs([bind, job('Test', ['Test'])])).toBe('code');
    expect(classifyFailedJobs([job('Test', [], 'success')])).toBeNull();
    expect(classifyFailedJobs([job('Test', [])])).toBe('code');
  });
  it('summarizes triggers, workflows, failure splits, daily selection and newest 100', () => {
    const runs = Array.from({ length: 105 }, (_, i) => run(i + 1));
    runs.push(run(106, { event: 'schedule', headBranch: 'master' }), run(107, { event: 'schedule', headBranch: 'master' }), run(108, { event: 'push', name: 'Build', conclusion: 'success' }), run(109, { event: 'custom', conclusion: 'cancelled' }));
    const result = summarizeCiRuns(runs.reverse(), new Map([[1, 'bind-artifact'], [2, 'code']]), { nowMs, windowHours: 24, repo: 'ashlrai/phantom' });
    expect(result.total).toBe(109);
    expect(result.byEvent).toEqual({ pull_request: 105, schedule: 2, push: 1, merge_group: 0, workflow_dispatch: 0, other: 1 });
    expect(result.byWorkflow).toContainEqual({ name: 'Build', total: 1, failed: 0 });
    expect(result.failures).toEqual({ total: 107, bindArtifact: 1, code: 1, unclassified: 105 });
    expect(result.daily?.runId).toBe(106);
    expect(result.recent).toHaveLength(100);
    expect(result.recent.map(r => r.runId)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(summarizeCiRuns([run(1, { createdAt: '2020-01-01T00:00:00Z' })], new Map(), { nowMs, windowHours: 1, repo: null }).total).toBe(0);
  });
  it('pages runs and jobs, respects newest classification cap and reads daily jobs', async () => {
    const paths: string[] = [];
    const result = await readCiRunFacts({ repo: 'ashlrai/phantom', nowMs, maxClassify: 1, gh: async args => {
      expect(args.slice(0, 3)).toEqual(['api', '-H', 'Accept: application/vnd.github+json']);
      const path = args[3]!; paths.push(path);
      if (path.includes('/jobs')) return JSON.stringify({ jobs: [job('Test', ['Bind candidate source'])] });
      const count = path.endsWith('page=1') ? 100 : 1;
      return JSON.stringify({ workflow_runs: Array.from({ length: count }, (_, i) => {
        const r = run(path.endsWith('page=1') ? i + 1 : 101);
        return { id: r.id, name: r.name, event: r.event, head_branch: r.headBranch, status: r.status, conclusion: r.conclusion, created_at: r.createdAt };
      }) });
    } });
    expect(result.available).toBe(true);
    expect(result.total).toBe(101);
    expect(result.failures).toEqual({ total: 101, bindArtifact: 1, code: 0, unclassified: 100 });
    expect(paths.filter(p => p.includes('/jobs'))).toHaveLength(1);
    expect(paths.some(p => p.includes('/1/jobs'))).toBe(true);
    expect(paths.some(p => p.endsWith('page=2'))).toBe(true);
  });
  it('reads the daily failed job names even with classification disabled', async () => {
    const result = await readCiRunFacts({ repo: 'ashlrai/phantom', nowMs, maxClassify: 0, gh: async args => {
      if (args[3]!.includes('/jobs')) return JSON.stringify({ jobs: [job('Merge Gate', ['Require selected CI lane'])] });
      return JSON.stringify({ workflow_runs: [{ id: 5, name: 'CI', event: 'schedule', head_branch: 'master', status: 'completed', conclusion: 'failure', created_at: new Date(nowMs).toISOString() }] });
    } });
    expect(result.daily?.failedJobs).toEqual(['Merge Gate']);
    expect(result.failures.unclassified).toBe(1);
  });
  it('stops after three run pages and deduplicates shifting pages', async () => {
    let calls = 0;
    const result = await readCiRunFacts({ repo: 'ashlrai/phantom', nowMs, maxClassify: 0, gh: async () => {
      calls++;
      return JSON.stringify({ workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'Build', event: 'push', status: 'completed', conclusion: 'success', created_at: new Date(nowMs).toISOString() })) });
    } });
    expect(calls).toBe(3);
    expect(result.total).toBe(100);
    expect(result.reason).toContain('three pages');
  });
  it('returns unavailable without stderr on GitHub failure', async () => {
    const result = await readCiRunFacts({ repo: 'ashlrai/phantom', nowMs, gh: async () => { throw new Error('stderr private credential'); } });
    expect(result.available).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('stderr');
  });
});
