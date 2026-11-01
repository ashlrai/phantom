import { describe, expect, it } from 'vitest';
import { cmdFleetCiDuplicateRuns } from '../src/cli/fleet-ci-duplicate-runs.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const sha = 'a'.repeat(40);
const since = '2026-11-01T00:00:00Z';
const now = '2026-11-01T03:00:00.000Z';
const run = (id: number, extra: Record<string, unknown> = {}) => ({
  id, workflow_id: 101, name: 'CI', head_sha: sha, run_attempt: 1, event: 'push', head_branch: 'topic',
  conclusion: 'failure', status: 'completed', created_at: '2026-11-01T01:00:00Z',
  run_started_at: '2026-11-01T01:00:00Z', updated_at: '2026-11-01T01:01:00Z', ...extra,
});
const ok = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: '' });
const page = (rows: unknown[], total = rows.length) => ok({ total_count: total, workflow_runs: rows });
const args = ['--repo', 'ashlrai/phantom', '--since', since, '--json'];
async function execute(gh: CloudGh, argv = args) {
  const logs: string[] = [];
  const errors: string[] = [];
  const calls: string[][] = [];
  const code = await cmdFleetCiDuplicateRuns(argv, { gh: async (a) => { calls.push(a); return gh(a); },
    now: () => new Date(now), output: { log: (s) => logs.push(s), error: (s) => errors.push(s) } });
  return { code, logs, errors, calls, report: logs.length && argv.includes('--json') ? JSON.parse(logs[0]!) : null };
}

describe('fleet ci-duplicate-runs', () => {
  it('groups push and PR on the same workflow and SHA and distinguishes reruns', async () => {
    const rows = [run(1), run(2, { event: 'pull_request', run_attempt: 2, run_started_at: '2026-11-01T01:04:00Z', updated_at: '2026-11-01T01:07:00Z' }),
      run(3, { event: 'schedule', head_sha: 'b'.repeat(40) }), run(4, { event: 'schedule', head_sha: 'c'.repeat(40) }),
      run(5, { workflow_id: 102, event: 'pull_request' })];
    const result = await execute(async (a) => a[1]?.includes('/attempts/')
      ? ok(run(2, { event: 'pull_request', run_started_at: '2026-11-01T01:02:00Z', updated_at: '2026-11-01T01:04:00Z' })) : page(rows));
    expect(result.code).toBe(0);
    expect(result.report.coverage).toMatchObject({ complete: true, truncated: false, runsRead: 5, attemptReads: 1, since, until: now });
    expect(result.report.groups).toHaveLength(1);
    expect(result.report.groups[0]).toMatchObject({ workflowId: 101, headSha: sha, separateRuns: true, rerunAttempts: true,
      pushPrDuplicate: true, repeatedFailedNotificationEvidence: true, attemptsComplete: true, observedRepeatedExecutionSeconds: 300 });
    expect(result.report.groups[0].attempts.map((r: { runId: number; attempt: number; event: string }) => [r.runId, r.attempt, r.event]))
      .toEqual([[1, 1, 'push'], [2, 1, 'pull_request'], [2, 2, 'pull_request']]);
    expect(result.report.groups[0].attempts[2].url).toBe('https://github.com/ashlrai/phantom/actions/runs/2/attempts/2');
    expect(result.calls[0]).toEqual(['api', '-X', 'GET', 'repos/ashlrai/phantom/actions/runs', '-f', 'per_page=100', '-f', 'page=1', '-f', `created=${since}..${now}`]);
    expect(result.report.notes.join(' ')).toMatch(/not billing savings.*email delivery is not observed/);
  });

  it('labels a single run rerun separately and does not infer push/PR overlap', async () => {
    const result = await execute(async (a) => a[1]?.includes('/attempts/') ? ok(run(1)) : page([run(1, { run_attempt: 2 })]));
    expect(result.report.groups[0]).toMatchObject({ separateRuns: false, rerunAttempts: true, pushPrDuplicate: false });
  });

  it('omits elapsed seconds if any timestamp is missing, invalid in order, or the run is active', async () => {
    for (const change of [{ run_started_at: null }, { updated_at: '2026-11-01T00:59:00Z' }, { status: 'in_progress', conclusion: null }]) {
      const result = await execute(async () => page([run(1), run(2, change)]));
      expect(result.report.groups[0].observedRepeatedExecutionSeconds).toBeNull();
    }
  });

  it('reports a genuinely empty page as complete and rejects inconsistent totals', async () => {
    const empty = await execute(async () => page([]));
    expect(empty.code).toBe(0);
    expect(empty.report.coverage.complete).toBe(true);
    expect(empty.report.groups).toEqual([]);
    for (const total of [0, 2]) {
      const mismatch = await execute(async () => page([run(1)], total));
      expect(mismatch.report.coverage.complete).toBe(false);
    }
  });

  it('marks failed or malformed pages incomplete without claiming a healthy empty report', async () => {
    for (const gh of [async () => ({ ok: false, stdout: '', stderr: 'secret error' }), async () => ok({ total_count: 1 }),
      async () => ({ ok: true, stdout: '{', stderr: '' }), async () => { throw new Error('offline'); }]) {
      const result = await execute(gh);
      expect(result.code).toBe(1);
      expect(result.report.coverage).toMatchObject({ complete: false, pagesRead: 0 });
      expect(result.logs[0]).not.toContain('secret error');
    }
    const malformed = await execute(async () => page([run(1, { head_sha: 'bad' })]));
    expect(malformed.report.coverage.complete).toBe(false);
  });

  it('keeps observed groups but marks a missing later page incomplete', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => run(i + 1, { head_sha: i < 2 ? sha : i.toString(16).padStart(40, '0') }));
    const result = await execute(async (a) => a.includes('page=1') ? page(rows, 101) : { ok: false, stdout: '', stderr: '' });
    expect(result.code).toBe(1);
    expect(result.report.coverage).toMatchObject({ complete: false, pagesRead: 1, truncated: false });
    expect(result.report.groups).toHaveLength(1);
  });

  it('marks the fixed page cap as truncated and incomplete', async () => {
    const result = await execute(async (a) => {
      const n = Number(a.find((x) => x.startsWith('page='))!.slice(5));
      return page(Array.from({ length: 100 }, (_, i) => run((n - 1) * 100 + i + 1, { head_sha: ((n - 1) * 100 + i).toString(16).padStart(40, '0') })), 301);
    });
    expect(result.code).toBe(1);
    expect(result.report.coverage).toMatchObject({ truncated: true, complete: false, pagesRead: 3, runsRead: 300 });
    expect(result.calls).toHaveLength(3);
  });

  it('marks unavailable or mismatched attempts incomplete and does not calculate seconds', async () => {
    for (const response of [{ ok: false, stdout: '', stderr: '' }, ok(run(77)), ok(run(1, { head_sha: 'b'.repeat(40) }))]) {
      const result = await execute(async (a) => a[1]?.includes('/attempts/') ? response : page([run(1, { run_attempt: 2 })]));
      expect(result.code).toBe(1);
      expect(result.report.groups[0]).toMatchObject({ rerunAttempts: true, attemptsComplete: false, observedRepeatedExecutionSeconds: null });
    }
  });

  it('caps historical attempt reads and reports incomplete', async () => {
    const result = await execute(async (a) => a[1]?.includes('/attempts/')
      ? ok(run(1, { run_attempt: Number(a[1]!.split('/').at(-1)) })) : page([run(1, { run_attempt: 12 })]));
    expect(result.calls).toHaveLength(11);
    expect(result.report.coverage.complete).toBe(false);
    expect(result.report.groups[0].attemptsComplete).toBe(false);
  });

  it('scrubs remote labels in both output modes and escapes terminal controls', async () => {
    const dirty = `ghp_${'a'.repeat(36)}\u001b[31m\u202e`;
    for (const argv of [args, args.slice(0, -1)]) {
      const result = await execute(async () => page([run(1, { name: dirty, head_branch: dirty }), run(2)]), argv);
      expect(result.logs[0]).not.toContain(dirty);
      expect(result.logs[0]).not.toContain('\u001b');
      expect(result.logs[0]).not.toContain('\u202e');
      expect(result.logs[0]).toContain('[REDACTED]');
    }
  });

  it('rejects invalid, repeated, missing and future arguments without reading GitHub', async () => {
    for (const argv of [[], ['--repo', '../x', '--since', since], ['--repo', 'x/y', '--since', '2026-02-30T00:00:00Z'],
      ['--repo', 'x/y', '--since', '2026-11-01T01:00:00-05:00'], ['--repo', 'x/y', '--since', '2026-11-02T00:00:00Z'],
      [...args, '--json'], [...args, '--other'], ['--repo', 'x/y', '--since']]) {
      const result = await execute(async () => { throw new Error('unexpected read'); }, argv);
      expect(result.code).toBe(2);
      expect(result.calls).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    }
  });
});
