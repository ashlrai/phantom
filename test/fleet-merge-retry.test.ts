import { describe, expect, it } from 'vitest';
import { cmdFleetMergeRetry, MAX_REQUESTS_PER_RUN } from '../src/cli/fleet-merge-retry.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const now = Date.parse('2026-11-09T18:00:00Z');
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const REPO = 'ashlrai/phantom';
const HEAD = 'a'.repeat(40);
const ev = (pr: number, type: string, secsAgo: number, extra: object = {}) =>
  ({ repo: REPO, pr, type, at: ago(secsAgo), ...extra });
/** The one transient queue failure shape merge-latency marks retryable. */
const failed = (pr: number, secsAgo = 700, extra: object = {}) => [
  ev(pr, 'auto_merge_enabled', 900), ev(pr, 'blocked', 800, { reason: 'queue' }),
  ev(pr, 'auto_merge_disabled', secsAgo, extra)];

type Recorded = { repo: string; pr: number; type: string; at: string; head_sha?: string };
function fixture(rows: unknown[], live: Record<number, object | null> = {}) {
  const ledger = rows.map(r => JSON.stringify(r)).join('\n');
  const recorded: Recorded[] = [];
  const calls: string[][] = [];
  let output = '';
  const state = { failMerge: false, failView: false };
  const gh: CloudGh = async args => {
    calls.push(args);
    if (args[1] === 'merge') return { ok: !state.failMerge, stdout: '', stderr: 'never expose provider errors' };
    if (state.failView) return { ok: false, stdout: '', stderr: 'never expose provider errors' };
    const pr = Number(args[2]);
    const view = live[pr];
    if (view === null) return { ok: false, stdout: '', stderr: 'never expose provider errors' };
    return {
      ok: true,
      stdout: JSON.stringify(view ?? { number: pr, state: 'OPEN', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'CLEAN', autoMergeRequest: null }),
      stderr: '',
    };
  };
  const run = (args: string[] = ['--json']) => cmdFleetMergeRetry(args, {
    gh, now, read: async () => ledger,
    record: async event => { recorded.push(event); },
    output: text => { output = text; },
  });
  const merges = () => calls.filter(args => args[1] === 'merge');
  return { run, state, calls, merges, recorded, get report() { return JSON.parse(output); }, get text() { return output; } };
}

describe('fleet merge-retry', () => {
  it('dry-runs retryable failures and needs-person rows without touching GitHub', async () => {
    const f = fixture([
      ...failed(7, 700, { head_sha: HEAD }),
      ev(8, 'auto_merge_enabled', 900), ev(8, 'auto_merge_disabled', 700),
    ]);
    expect(await f.run()).toBe(0);
    expect(f.report).toMatchObject({ schema: 'fleet.merge-retry.v1', dryRun: true, ok: true, known: true, max_retries_per_pr: 3 });
    expect(f.report.rows).toEqual([
      { repo: REPO, pr: 7, action: 'request-auto-merge', disabled_at: ago(700), waiting_s: 700, retries_left: 3, requests_failed: 0, head_sha: HEAD },
      { repo: REPO, pr: 8, action: 'needs-person', reason: 'unattributed', requests_failed: 0 },
    ]);
    expect(f.calls).toEqual([]);
  });

  it('success: --apply requests ordinary head-pinned auto-merge and records the retry', async () => {
    const f = fixture(failed(7, 700));
    expect(await f.run(['--apply', '--json'])).toBe(0);
    expect(f.report.rows[0]).toMatchObject({ pr: 7, action: 'auto-merge-requested' });
    expect(f.merges()).toEqual([['pr', 'merge', '7', '--repo', REPO, '--auto', '--match-head-commit', HEAD]]);
    expect(f.recorded).toEqual([{ repo: REPO, pr: 7, type: 'retry_requested', at: new Date(now).toISOString(), head_sha: HEAD }]);
    // The recorded retry is exactly what merge-latency counts.
    const second = fixture([...failed(7), ...f.recorded]);
    expect(await second.run(['--apply', '--json'])).toBe(0);
    expect(second.report.rows[0]).toMatchObject({ pr: 7, action: 'needs-person', reason: 'already-requested' });
    expect(second.merges()).toEqual([]);
  });

  it('retry exhaustion: three recorded retries needs a person and never calls merge', async () => {
    const f = fixture([
      ...failed(7),
      ev(7, 'retry_requested', 950), ev(7, 'retry_requested', 850), ev(7, 'retry_requested', 750),
    ]);
    expect(await f.run(['--apply', '--json'])).toBe(0);
    expect(f.report.rows).toEqual([{ repo: REPO, pr: 7, action: 'needs-person', reason: 'too-many-retries', requests_failed: 0 }]);
    expect(f.merges()).toEqual([]);
    expect(f.recorded).toEqual([]);
  });

  it('duplicate events: replayed ledger lines count once and a second apply does not re-request', async () => {
    // The same retry_requested line replayed three times is one retry, not three.
    const dup = ev(7, 'retry_requested', 950, { head_sha: HEAD });
    const f = fixture([...failed(7), dup, dup, dup]);
    expect(await f.run(['--apply', '--json'])).toBe(0);
    expect(f.report.rows[0]).toMatchObject({ pr: 7, action: 'auto-merge-requested', retries_left: 2 });
    // Replaying the whole applied ledger (disable + recorded retry) re-requests nothing.
    const replay = fixture([...failed(7), ...f.recorded, ...f.recorded]);
    expect(await replay.run(['--apply', '--json'])).toBe(0);
    expect(replay.merges()).toEqual([]);
    expect(replay.report.rows[0]).toMatchObject({ pr: 7, action: 'needs-person', reason: 'already-requested' });
    // Duplicate disable lines are still one failure.
    const bounced = [...failed(9), ...failed(9)];
    const g = fixture(bounced);
    expect(await g.run()).toBe(0);
    expect(g.report.rows).toHaveLength(1);
  });

  it('skips armed, drafted, conflicting and finished PRs and reports a failed request for the next run', async () => {
    const f = fixture([...failed(1), ...failed(2), ...failed(3), ...failed(4), ...failed(5)], {
      1: { number: 1, state: 'OPEN', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'CLEAN', autoMergeRequest: {} },
      2: { number: 2, state: 'OPEN', headRefOid: HEAD, isDraft: true, mergeStateStatus: 'CLEAN', autoMergeRequest: null },
      3: { number: 3, state: 'OPEN', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'DIRTY', autoMergeRequest: null },
      4: { number: 4, state: 'MERGED', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'CLEAN', autoMergeRequest: null },
      5: { number: 5, state: 'OPEN', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'CLEAN', autoMergeRequest: null },
    });
    f.state.failMerge = true;
    expect(await f.run(['--apply', '--json'])).toBe(1);
    expect(f.report.rows.map((r: { pr: number; action: string }) => [r.pr, r.action])).toEqual([
      [1, 'already-armed'], [2, 'draft'], [3, 'conflict'], [4, 'merged'], [5, 'failed']]);
    // Only #5 reached a submission attempt: it records one retry_failed event.
    expect(f.recorded).toEqual([{ repo: REPO, pr: 5, type: 'retry_failed', at: new Date(now).toISOString(), head_sha: HEAD }]);
    f.state.failMerge = false;
    expect(await f.run(['--apply', '--json'])).toBe(0); // a transient submission failure retries on the next run
    expect(f.recorded).toHaveLength(2);
    expect(f.recorded[1]).toMatchObject({ pr: 5, type: 'retry_requested' });
  });

  it('caps merge requests per run and never retries held phantom PRs', async () => {
    const f = fixture([...failed(10), ...failed(11), ...failed(12), ...failed(13)]);
    expect(await f.run(['--apply', '--json'])).toBe(0);
    expect(f.merges()).toHaveLength(MAX_REQUESTS_PER_RUN);
    expect(f.report.rows.map((r: { pr: number; action: string }) => [r.pr, r.action]))
      .toEqual([[10, 'auto-merge-requested'], [11, 'auto-merge-requested'], [12, 'auto-merge-requested'], [13, 'capped']]);
    const held = fixture(failed(197));
    expect(await held.run(['--apply', '--json'])).toBe(0);
    expect(held.report.rows[0].action).toBe('held');
    expect(held.calls).toEqual([]);
  });

  it('keeps a transient submission failure retryable but makes three distinct failures permanent', async () => {
    // One recorded submission failure: still retryable, and the budget shows up.
    const f = fixture([...failed(7), ev(7, 'retry_failed', 600, { head_sha: HEAD })]);
    expect(await f.run(['--apply', '--json'])).toBe(0);
    expect(f.report.rows[0]).toMatchObject({ pr: 7, action: 'auto-merge-requested', requests_failed: 1, retries_left: 3 });
    // Three distinct failed submissions: the drop is permanent — no GitHub call at all.
    const g = fixture([...failed(8),
      ev(8, 'retry_failed', 600, { head_sha: HEAD }), ev(8, 'retry_failed', 500, { head_sha: HEAD }), ev(8, 'retry_failed', 400)]);
    expect(await g.run(['--apply', '--json'])).toBe(0);
    expect(g.report.rows).toEqual([{ repo: REPO, pr: 8, action: 'needs-person', reason: 'request-failed', requests_failed: 3 }]);
    expect(g.calls).toEqual([]);
    // Replayed identical failure lines dedupe to one submission failure.
    const h = fixture([...failed(9), ev(9, 'retry_failed', 600, { head_sha: HEAD }), ev(9, 'retry_failed', 600, { head_sha: HEAD })]);
    expect(await h.run(['--apply', '--json'])).toBe(0);
    expect(h.report.rows[0]).toMatchObject({ pr: 9, action: 'auto-merge-requested', requests_failed: 1 });
  });

  it('reports a failed state read without recording — it was never a submission attempt', async () => {
    const f = fixture(failed(7));
    f.state.failView = true;
    expect(await f.run(['--apply', '--json'])).toBe(1);
    expect(f.report.rows[0]).toMatchObject({ pr: 7, action: 'failed' });
    expect(f.recorded).toEqual([]);
    f.state.failView = false;
    expect(await f.run(['--apply', '--json'])).toBe(0); // a failed read retries for free
    expect(f.report.rows[0].action).toBe('auto-merge-requested');
    expect(f.recorded).toEqual([{ repo: REPO, pr: 7, type: 'retry_requested', at: new Date(now).toISOString(), head_sha: HEAD }]);
  });

  it('leaves closed and not-ready PRs alone without recording or submitting', async () => {
    const f = fixture([...failed(1), ...failed(2)], {
      1: { number: 1, state: 'CLOSED', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'CLEAN', autoMergeRequest: null },
      2: { number: 2, state: 'OPEN', headRefOid: HEAD, isDraft: false, mergeStateStatus: 'UNKNOWN', autoMergeRequest: null },
    });
    expect(await f.run(['--apply', '--json'])).toBe(0);
    expect(f.report.rows.map((r: { pr: number; action: string }) => [r.pr, r.action])).toEqual([[1, 'closed'], [2, 'not-ready']]);
    expect(f.merges()).toEqual([]);
    expect(f.recorded).toEqual([]);
  });

  it('honours the event repo, fails honestly on unreadable ledgers and rejects bad arguments', async () => {
    const other = fixture([{ ...ev(6, 'auto_merge_enabled', 900), repo: 'ashlrai/other' },
      { ...ev(6, 'blocked', 800, { reason: 'queue' }), repo: 'ashlrai/other' },
      { ...ev(6, 'auto_merge_disabled', 700), repo: 'ashlrai/other' }]);
    expect(await other.run(['--apply', '--json'])).toBe(0);
    expect(other.merges()).toEqual([['pr', 'merge', '6', '--repo', 'ashlrai/other', '--auto', '--match-head-commit', HEAD]]);
    const unreadable = await cmdFleetMergeRetry(['--json'], { read: async () => null, output: () => {} });
    expect(unreadable).toBe(1);
    const f = fixture(failed(7));
    for (const bad of [['--nope'], ['--events'], ['--json', '--json'], ['--apply', '--apply'], ['x']]) {
      expect(await f.run(bad)).toBe(2);
    }
    expect(await f.run(['--help'])).toBe(0);
    expect(f.text).toContain('merge-retry');
  });

  it('is reachable as `phm fleet merge-retry`', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['merge-retry']!();
    expect(typeof mod.cmdFleetMergeRetry).toBe('function');
  });
});
