/**
 * test/friction-ledger.test.ts — the phm friction miners, ledger fold and
 * CLI seams, all against fixtures in a temporary runs dir.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFrictionLedger, foldFrictionLedger, frictionNoteRow, frictionScanRow,
  mineFriction, readFrictionInput,
} from '../src/core/fleet/friction.js';
import { cmdFriction } from '../src/cli/friction.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const iso = (hAgo: number) => new Date(NOW - hAgo * 3_600_000).toISOString();
const local = (hAgo: number) => new Date(NOW - hAgo * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
const J = (o: object) => JSON.stringify(o);
const item = (report: ReturnType<typeof mineFriction>, id: string) => report.items.find(i => i.id === id)!;

const jobs = [
  J({ event: 'enqueue', job: 'RQ-A', lane: 'devin', tier: 'work', ts: iso(30) }),
  J({ event: 'enqueue', job: 'RQ-B', lane: 'devin', tier: 'work', ts: iso(10) }),
  J({ event: 'enqueue', job: 'RQ-C', lane: 'codex', tier: 'standard', ts: iso(2) }),   // invalid tier
  J({ event: 'finish', job: 'RQ-X', lane: 'devin', ts: iso(20), empty: true, exit_code: 0 }),
  J({ event: 'finish', job: 'RQ-Y', lane: 'devin', ts: iso(19), empty: false, exit_code: 3 }),
  J({ event: 'finish', job: 'RQ-Z', lane: 'claude', ts: iso(18), empty: false, pool_error: 'usage_limit' }),
  J({ event: 'finish', job: 'RQ-W', lane: 'devin', ts: iso(4), empty: false }),        // relogin after auth hold
  J({ event: 'autobackoff_hold', lane: 'devin', job: 'RQ-V', ts: iso(8), pattern: 'claude_auth_401', auth_failures: 2 }),
  J({ event: 'autobackoff_hold', lane: 'claude', job: 'RQ-U', ts: iso(7), pattern: 'usage_limit' }),
  J({ event: 'autobackoff_skip', lane: 'devin', job: 'RQ-T', ts: iso(6), pattern: 'usage_limit' }),
  J({ event: 'precheck_parked', job: 'RQ-S', lane: 'devin', ts: iso(5), code: 13 }),
  J({ event: 'dispatch_deferred', job: 'RQ-D1', repo: 'phantom', reason: 'duplicate-request', repeatOf: 'RQ-A', ts: iso(3) }),
  J({ event: 'dispatch_deferred', job: 'RQ-D1', repo: 'phantom', reason: 'duplicate-request', repeatOf: 'RQ-A', ts: iso(2) }),
  J({ event: 'dispatch_deferred', job: 'RQ-D2', repo: 'phantom', reason: 'duplicate-request', repeatOf: 'RQ-B', ts: iso(1) }),
  J({ event: 'dispatch_deferred', job: 'RQ-OLD', repo: 'phantom', reason: 'duplicate-request', repeatOf: 'RQ-A', ts: iso(200) }),
  J({ event: 'recut_admission', job: 'RQ-R1', repo: 'phantom', action: 'defer', reason: 'recut-in-flight', repeatOf: 'RQ-PHX-RECUT1L1', targetPr: 1, headSha: 'a'.repeat(40), ts: iso(3) }),
  J({ event: 'recut_admission', job: 'RQ-R1', repo: 'phantom', action: 'defer', reason: 'recut-in-flight', repeatOf: 'RQ-PHX-RECUT1L1', ts: iso(2) }),
  J({ event: 'recut_admission', job: 'RQ-R2', repo: 'phantom', action: 'defer', reason: 'recut-in-flight', repeatOf: 'RQ-PHX-RECUT2L1', ts: iso(1) }),
  J({ event: 'recut_admission', job: 'RQ-R3', repo: 'phantom', action: 'skip', reason: 'recut-already-merged', repeatOf: 'RQ-PHX-RECUT3L1', ts: iso(1) }),
  J({ event: 'recut_admission', job: 'RQ-R4', repo: 'phantom', action: 'ready', reason: 'recut-no-current-coverage', ts: iso(1) }),
  J({ event: 'recut_admission', job: 'RQ-R5', repo: 'phantom', action: 'defer', reason: 'recut-in-flight', repeatOf: 'RQ-PHX-RECUT9L9', ts: iso(200) }),
].join('\n');
const events = [
  `${local(15)} LAUNCH_DEFERRED RQ-1 PAUSED (requeued)`,
  `${local(14)} USAGE_LIMIT_SEEN codex RQ-2 codex_usage_limit: provider named the reset`,
  `${local(13)} AUTH_FAILURE_SEEN claude RQ-3 claude_auth_401: run produced work, no hold`,
  `${local(12)} LANE_HOLD devin autobackoff pattern=claude_auth_401 job=RQ-4 until=x src=default`,
  `${local(11)} LANE_HOLD claude credits exhausted (credits_exhausted); supervisor clears held`,
  `${local(10)} ROUTE RQ-5 devin->codex-personal`,
  `${local(9)} PARKED-DEP RQ-6 deps=RQ-7,RQ-8`,
  `${local(200)} ROUTE RQ-9 old->older`,   // outside the 7d window
].join('\n');
const ready = [
  'RQ-A\tphantom\tdevin\twork\tqueue/prompts/RQ-A.md',          // enqueue 30h ago, no launch: stale
  'RQ-B\tphantom\tdevin\twork\tqueue/prompts/RQ-B.md',          // 10h, no launch: stale
  'RQ-C\tphantom\tdevin\tplatinum\tqueue/prompts/RQ-C.md',      // invalid tier
  'PARKED-DEP.devin\tRQ-6\tdevin\twork\tphantom\tqueue/prompts/RQ-6.md',
  'RQ-NEW\tphantom\tdevin\twork\tqueue/prompts/RQ-NEW.md',      // never enqueued: age unknown
].join('\n');
const guardian = J({ 'ashlrai/phantom': { state: 'red', red_first: iso(26), attempts: 2, cur_job: 'RQ-FIX-1' }, 'ashlrai/locus': { state: 'green' } });
const slots = J({ devin: { held: true, held_by: 'autobackoff', held_until: iso(-1) }, claude: { held: true, held_by: 'phantom mason 2026-11-03' }, 'codex-personal': { target: 10 } });

function fixture(over: Partial<Parameters<typeof mineFriction>[0]> = {}) {
  return mineFriction({ jobs, events, ready, guardian, slots, overrides: J({ devin: { floor: 3 } }), keep: 'RQ-KEPT\nRQ-A\n', now: NOW, ...over });
}

describe('phm friction miners', () => {
  it('counts 7d signals per item with evidence and score ordering', () => {
    const r = fixture();
    expect(r.schema).toBe('phm.friction.v1');
    expect(item(r, 'empty-finishes').signals).toMatchObject({ bad: 3, empty: 1, refused: 1, failed: 1 });
    expect(item(r, 'requeues').signals.requeued).toBe(1);
    expect(item(r, 'lane-auth').signals).toMatchObject({ auth_failures: 2, auth_holds: 1, relogins: 1 });
    expect(item(r, 'quota-exhaustion').signals).toMatchObject({ usage_limits: 5, finish_errors: 1, credit_holds: 1, backoff_holds: 1 });
    expect(item(r, 'invalid-tier').signals).toMatchObject({ ready_rows: 1, enqueued: 1 });
    expect(item(r, 'red-main').signals).toMatchObject({ repos_red: 1, max_red_hours: 26 });
    expect(item(r, 'stale-ready').signals).toMatchObject({ unclaimed: 2, unknown_age: 1 });
    expect(item(r, 'manual-interventions').signals).toMatchObject({ manual_holds: 1, budget_overrides: 1, kept_jobs: 2 });
    expect(item(r, 'wrong-route').signals).toMatchObject({ route_moves: 1, route_holds: 0 });
    expect(item(r, 'holds').signals).toMatchObject({ hold_events: 4, lanes_held: 2, parked_rows: 1, precheck_parks: 1 });
    expect(item(r, 'deferred-requests').signals).toMatchObject({ deferred_jobs: 4, deferrals: 3, recut_deferrals: 3, recut_deferred_jobs: 2 });
    expect(item(r, 'deferred-requests').evidence[0]).toContain('dispatch_deferred');
    expect(item(r, 'deferred-requests').evidence.join(' ')).toContain('recut_admission job=RQ-R1 repeatOf=RQ-PHX-RECUT1L1');
    expect(item(r, 'empty-finishes').evidence[0]).toContain('jobs.jsonl');
    expect(item(r, 'empty-finishes').score).toBe(13.5);  // 3 unlock x 3 bad x 3 blast / 2 cost
    expect(r.items[0]!.score ?? -1).toBeGreaterThanOrEqual(r.items.at(-1)!.score ?? -1);
  });
  it('reads jobs-ledger dialect spellings for events, ids, lanes and stamps', () => {
    const dialectJobs = [
      J({ type: 'finish', job_id: 'RQ-E1', pool: 'devin', recordedAt: iso(3), empty: true, exit_code: 0 }),
      J({ kind: 'enqueue', id: 'RQ-E2', lane: 'codex', time: iso(2), tier: 'bogus-tier' }),
    ].join('\n');
    const r = mineFriction({ jobs: dialectJobs, now: NOW });
    expect(item(r, 'empty-finishes').signals).toMatchObject({ empty: 1 });
    expect(item(r, 'invalid-tier').signals.enqueued).toBe(1);
  });
  it('keeps signals unknown (null), never zero, when sources are missing', () => {
    const r = mineFriction({ now: NOW });
    expect(item(r, 'empty-finishes').signals.bad).toBeNull();
    expect(item(r, 'empty-finishes').score).toBeNull();
    expect(item(r, 'empty-finishes').status).toBe('quiet');
    expect(r.sources['metrics/jobs.jsonl']).toBe('missing');
  });
  it('reports real zeros from read sources and ignores stale events', () => {
    const r = fixture({ jobs: J({ event: 'finish', job: 'RQ-1', ts: iso(200), empty: true }) });
    expect(item(r, 'empty-finishes').signals.bad).toBe(0);
    expect(item(r, 'wrong-route').signals.route_moves).toBe(1); // the 200h-old ROUTE line is not counted
  });
  it('counts dispatch_deferred dedup receipts without inventing job ids', () => {
    const rows = [
      J({ event: 'dispatch_deferred', repo: 'phantom', reason: 'duplicate-request', repeatOf: 'RQ-A', ts: iso(1) }),
      J({ event: 'dispatch_deferred', job: 'RQ-D1', repeatOf: 'bad/owner', ts: iso(2) }),
    ].join('\n');
    const r = mineFriction({ jobs: rows, now: NOW });
    const d = item(r, 'deferred-requests');
    expect(d.signals).toMatchObject({ deferrals: 2, deferred_jobs: 1 });
    expect(d.evidence.join(' ')).not.toContain('bad/owner');
    expect(item(mineFriction({ now: NOW }), 'deferred-requests').signals.deferred_jobs).toBeNull();
    expect(item(fixture({ jobs: '' }), 'deferred-requests').signals).toMatchObject({ deferred_jobs: 0, deferrals: 0 });
  });
  it('counts recut_admission defers as deferred jobs and ignores other actions', () => {
    const rows = [
      J({ event: 'recut_admission', job: 'RQ-R1', repo: 'phantom', action: 'defer', reason: 'recut-in-flight', repeatOf: 'RQ-PHX-RECUT1L1', ts: iso(2) }),
      J({ event: 'recut_admission', job: 'RQ-R1', repo: 'phantom', action: 'Defer', repeatOf: 'RQ-PHX-RECUT1L1', ts: iso(1) }),
      J({ event: 'recut_admission', job: 'RQ-R2', repo: 'phantom', action: 'skip', reason: 'recut-already-merged', repeatOf: 'RQ-PHX-RECUT2L1', ts: iso(1) }),
      J({ event: 'recut_admission', job: 'RQ-R3', repo: 'phantom', action: 'ready', reason: 'recut-no-current-coverage', ts: iso(1) }),
      J({ event: 'recut_admission', repo: 'phantom', action: 'defer', repeatOf: 'RQ-PHX-RECUT4L1', ts: iso(1) }),
      J({ event: 'recut_admission', job: 'RQ-R5', repo: 'phantom', action: 'defer', repeatOf: 'bad/owner', ts: iso(0.5) }),
    ].join('\n');
    const d = item(mineFriction({ jobs: rows, now: NOW }), 'deferred-requests');
    expect(d.signals).toMatchObject({ deferred_jobs: 2, deferrals: 0, recut_deferrals: 4, recut_deferred_jobs: 2 });
    expect(d.evidence.join(' ')).not.toContain('bad/owner');
    const none = item(mineFriction({ now: NOW }), 'deferred-requests');
    expect(none.signals).toMatchObject({ recut_deferrals: null, recut_deferred_jobs: null });
    const empty = item(fixture({ jobs: '' }), 'deferred-requests');
    expect(empty.signals).toMatchObject({ recut_deferrals: 0, recut_deferred_jobs: 0 });
  });
  it('counts adaptive-concurrency cap sheds and the danger zones behind them', () => {
    const rows = [
      J({ event: 'concurrency', from: 18, to: 13, reason: 'backoff fork,mem_free', zones: { fork: 'danger', mem_free: 'danger', load: 'ok' }, ts: iso(2) }),
      J({ event: 'concurrency', from: 13, to: 11, reason: 'backoff rate_limit', zones: { rate_limit: 'danger', swap: 'warn' }, ts: iso(1) }),
      J({ event: 'concurrency', from: 11, to: 13, reason: 'raise headroom', zones: { load: 'ok' }, ts: iso(0.5) }),
      J({ event: 'concurrency', from: 18, to: 18, reason: 'bounds', zones: {}, ts: iso(0.4) }),
      J({ event: 'concurrency', reason: 'backoff fork', ts: iso(0.3) }),
      J({ event: 'concurrency', from: 9, to: 7, reason: 'backoff swap', zones: { swap: 'danger' }, ts: iso(200) }),
    ].join('\n');
    const c = item(mineFriction({ jobs: rows, now: NOW }), 'concurrency-throttle');
    expect(c.signals).toMatchObject({ backoffs: 2, raises: 1, danger_fork: 1, danger_mem_free: 1, danger_rate_limit: 1, danger_swap: 0 });
    expect(c.evidence.join(' ')).toContain('jobs.jsonl concurrency 18->13 backoff fork,mem_free');
    expect(item(mineFriction({ now: NOW }), 'concurrency-throttle').signals.backoffs).toBeNull();
    expect(item(fixture({ jobs: '' }), 'concurrency-throttle').signals).toMatchObject({ backoffs: 0, raises: 0 });
  });
  it('folds launch_failed receipts: retries counted, terminal give-ups open requeues', () => {
    const rows = [
      J({ event: 'launch_failed', job: 'RQ-L1', lane: 'devin', ts: iso(3), reason: 'launch_timeout', class: 'retryable', attempt: 1, max_attempts: 3, action: 'retry' }),
      J({ event: 'launch_failed', job: 'RQ-L2', lane: 'devin', ts: iso(2), reason: 'launch_script_error', class: 'permanent', attempt: 1, max_attempts: 3, action: 'give_up' }),
      J({ event: 'launch_failed', job: 'RQ-L3', ts: iso(1), reason: 'launch_interrupted', action: 'give_up', attempt: 1 }),
      J({ event: 'launch_failed', job: 'RQ-L4', ts: iso(1) }),                          // no action: total only
      J({ event: 'launch_failed', job: 'RQ-OLD', ts: iso(200), action: 'give_up' }),    // outside the 7d window
      J({ event: 'launch_terminal', job: 'RQ-L5', ts: iso(1), reason: 'launcher-exited' }), // not a failure verdict
    ].join('\n');
    const r = mineFriction({ jobs: rows, now: NOW });
    const rq = item(r, 'requeues');
    expect(rq.signals).toMatchObject({ launch_failures: 4, launch_retries: 1, launch_giveups: 2, requeued: null });
    expect(rq.status).toBe('open'); // give-ups open the item even with no requeue lines
    expect(rq.evidence.join(' ')).toContain('launch_failed job=RQ-L2 give_up reason=launch_script_error class=permanent');
    expect(rq.evidence.join(' ')).not.toContain('RQ-OLD');
    const quiet = item(mineFriction({ now: NOW }), 'requeues');
    expect(quiet.signals).toMatchObject({ launch_failures: null, launch_retries: null, launch_giveups: null });
    expect(quiet.status).toBe('quiet');
    const empty = item(fixture({ jobs: '' }), 'requeues');
    expect(empty.signals).toMatchObject({ launch_failures: 0, launch_giveups: 0 });
  });
  it('counts merge-queue drag from merge-events.jsonl per distinct PR', () => {
    const mergeEvents = [
      // #101: the full drag arc — conflict, recut, retries, a dropped
      // auto-merge, failing check observations and blocked transitions.
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'opened', at: iso(50) }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'queued', at: iso(49) }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'conflict', at: iso(48), head_sha: 'a'.repeat(40) }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'recut_requested', at: iso(47), head_sha: 'a'.repeat(40) }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'retry_requested', at: iso(46), head_sha: 'a'.repeat(40) }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'retry_failed', at: iso(45), head_sha: 'a'.repeat(40) }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'auto_merge_disabled', at: iso(44) }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'check_observed', at: iso(43), conclusion: 'failure', required: true }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'check_observed', at: iso(42), conclusion: 'failure' }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'check_observed', at: iso(41), conclusion: 'success', required: true }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'blocked', at: iso(40), reason: 'required_checks' }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'blocked', at: iso(39), reason: 'conflict' }),
      J({ repo: 'ashlrai/phantom', pr: 101, type: 'blocked', at: iso(38), reason: 'review' }),
      // #102: one unrelated check failure and a queue block — drag through
      // the failure conclusion only; the block stays context.
      J({ repo: 'ashlrai/phantom', pr: 102, type: 'check_observed', at: iso(30), conclusion: 'failure', required: false }),
      J({ repo: 'ashlrai/phantom', pr: 102, type: 'blocked', at: iso(29), reason: 'queue' }),
      // #103: clean lifecycle — observed coverage, never drag.
      J({ repo: 'ashlrai/phantom', pr: 103, type: 'opened', at: iso(20) }),
      J({ repo: 'ashlrai/phantom', pr: 103, type: 'queued', at: iso(19) }),
      J({ repo: 'ashlrai/phantom', pr: 103, type: 'checks_passed', at: iso(18) }),
      J({ repo: 'ashlrai/phantom', pr: 103, type: 'merged', at: iso(17) }),
      // Outside the 7d window, undated (unwindowable), malformed and
      // off-contract rows never count.
      J({ repo: 'ashlrai/phantom', pr: 104, type: 'conflict', at: iso(200) }),
      J({ repo: 'ashlrai/phantom', pr: 105, type: 'auto_merge_disabled' }),
      'not json',
      J({ repo: 'ashlrai/phantom', pr: 106, type: 'bogus', at: iso(5) }),
      J({ repo: 'ashlrai/phantom', pr: 107, type: 'blocked', at: iso(5) }),
      J({ repo: 'ashlrai/phantom', pr: 108, type: 'check_observed', at: iso(5) }),
      J({ repo: 'bad repo', pr: 109, type: 'conflict', at: iso(5) }),
    ].join('\n');
    const r = mineFriction({ mergeEvents, now: NOW });
    const mq = item(r, 'merge-queue');
    expect(mq.status).toBe('open');
    expect(mq.signals).toMatchObject({
      merge_drag: 2, merge_events: 19, observed_prs: 3,
      conflicts: 1, conflicted_prs: 1, recuts: 1, retries: 1, retry_failures: 1,
      auto_merge_dropped: 1, auto_merge_dropped_prs: 1,
      check_failures: 3, required_check_failures: 1,
      blocked: 4, blocked_required_checks: 1, blocked_conflict: 1,
      blocked_review: 1, blocked_queue: 1, blocked_other: 0,
    });
    expect(mq.score).toBe(9); // 3 unlock x 2 drag prs x 3 blast / 2 cost
    expect(mq.metric).toMatchObject({ unit: 'merge_drag', after: 2 });
    expect(mq.evidence.slice(0, 3)).toEqual([
      'merge-events.jsonl conflict ashlrai/phantom#101',
      'merge-events.jsonl recut_requested ashlrai/phantom#101',
      'merge-events.jsonl retry_requested ashlrai/phantom#101',
    ]);
    expect(mq.evidence.join(' ')).not.toContain('#104');
  });
  it('keeps merge-queue signals unknown without the ledger and zero on an empty or quiet one', () => {
    const missing = item(mineFriction({ now: NOW }), 'merge-queue');
    expect(missing.signals.merge_drag).toBeNull();
    expect(missing.signals.blocked_required_checks).toBeNull();
    expect(missing.score).toBeNull();
    expect(missing.status).toBe('quiet');
    const empty = item(mineFriction({ mergeEvents: '', now: NOW }), 'merge-queue');
    expect(empty.signals).toMatchObject({ merge_drag: 0, merge_events: 0, observed_prs: 0, conflicts: 0 });
    expect(empty.status).toBe('quiet');
    // Lifecycle and blocked rows alone are observed coverage, never drag.
    const quiet = item(mineFriction({ mergeEvents: [
      J({ repo: 'ashlrai/phantom', pr: 1, type: 'opened', at: iso(5) }),
      J({ repo: 'ashlrai/phantom', pr: 1, type: 'merged', at: iso(4) }),
      J({ repo: 'ashlrai/phantom', pr: 2, type: 'blocked', at: iso(3), reason: 'review' }),
    ].join('\n'), now: NOW }), 'merge-queue');
    expect(quiet.signals).toMatchObject({ merge_drag: 0, merge_events: 3, observed_prs: 2, blocked: 1, blocked_review: 1 });
    expect(quiet.status).toBe('quiet');
  });
  it('scrubs secret-shaped text out of evidence', () => {
    const token = 'sk-ant-' + 'a1'.repeat(30);
    const r = fixture({ events: `${local(1)} AUTH_FAILURE_SEEN claude RQ-3 ${token}: refused` });
    expect(JSON.stringify(r.items)).not.toContain(token);
  });
});

describe('phm friction ledger', () => {
  it('appends a scan row only when counts change, and folds before/after', () => {
    const report = fixture();
    const fold = foldFrictionLedger('');
    const row = frictionScanRow(report, fold, NOW);
    expect(row).not.toBeNull();
    const folded = foldFrictionLedger(row!);
    expect(foldFrictionLedger(JSON.stringify({ kind: 'scan', ts: iso(50), items: { holds: 9 } }) + '\n' + row!)
      .scans.get('holds')).toMatchObject({ before: 9, after: 4 });
    expect(frictionScanRow(report, folded, NOW + 1000)).toBeNull();
  });
  it('folds notes into owner/status, marks fixed+recurring as regressed', () => {
    const ledger = [
      J({ kind: 'note', ts: iso(3), item: 'holds', status: 'in-progress', owner: 'core' }),
      J({ kind: 'note', ts: iso(2), item: 'empty-finishes', status: 'fixed' }),
      J({ kind: 'bogus' }), 'not json',
    ].join('\n');
    const r = fixture({ ledger });
    expect(item(r, 'holds')).toMatchObject({ status: 'in-progress', owner: 'core' });
    expect(item(r, 'empty-finishes').status).toBe('regressed');
    expect(item(r, 'requeues').status).toBe('open');
  });
  it('validates note rows against the item catalog', () => {
    expect(frictionNoteRow('holds', 'fixed', 'core', NOW)).toContain('"item":"holds"');
    expect(frictionNoteRow('nope', 'fixed', undefined, NOW)).toBeNull();
    expect(frictionNoteRow('holds', 'done', undefined, NOW)).toBeNull();
    expect(frictionNoteRow('holds', 'fixed', 'bad/slash', NOW)).toBeNull();
  });
});

describe('phm friction command', () => {
  it('reads a runs dir, appends the ledger and prints the report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'friction-'));
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'guardian'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs);
    await writeFile(join(dir, 'metrics', 'merge-events.jsonl'),
      J({ repo: 'ashlrai/phantom', pr: 55, type: 'conflict', at: iso(2) }));
    await writeFile(join(dir, 'queue', 'dispatch-events.log'), events);
    await writeFile(join(dir, 'queue', 'ready.tsv'), ready);
    await writeFile(join(dir, 'guardian', 'state.json'), guardian);
    const input = await readFrictionInput(dir);
    const report = mineFriction({ ...input, now: NOW });
    expect(item(report, 'invalid-tier').signals.ready_rows).toBe(1);
    expect(item(report, 'merge-queue').signals).toMatchObject({ merge_drag: 1, conflicts: 1 });
    expect(input.sourceStates?.['metrics/merge-events.jsonl']).toBe('read');
    const row = frictionScanRow(report, foldFrictionLedger(input.ledger ?? ''), NOW);
    await appendFrictionLedger(dir, [row!]);
    const ledger = await readFile(join(dir, 'friction', 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"scan"');
    const notes = await cmdFriction(['note', 'holds', '--status', 'in-progress', '--owner', 'core', '--runs-dir', dir, '--json']);
    expect(notes).toBe(0);
    expect(await readFile(join(dir, 'friction', 'ledger.jsonl'), 'utf8')).toContain('"kind":"note"');
    expect(await cmdFriction(['note', 'holds', '--status', 'bogus', '--runs-dir', dir])).toBe(2);
    expect(await cmdFriction(['--runs-dir'])).toBe(2);
  });
});

it('reports large and inconsistent finish diffs without guessing their cause', () => {
  const ts = new Date().toISOString();
  const jobs = [
    { event: 'finish', job: 'RQ-LARGE', ts, diff_files: 2, diff_lines: 500, empty: false },
    { event: 'finish', job: 'RQ-INCONSISTENT', ts, diff_files: 0, diff_lines: 1, empty: true },
    { event: 'finish', job: 'RQ-NORMAL', ts, diff_files: 1, diff_lines: 10, empty: false },
  ].map(row => JSON.stringify(row)).join('\n');
  const item = mineFriction({ jobs }).items.find(row => row.id === 'anomalous-diffs');
  expect(item?.signals.finishes).toBe(2);
  expect(item?.evidence).toHaveLength(2);
  expect(mineFriction({}).items.find(row => row.id === 'anomalous-diffs')?.signals.finishes).toBeNull();
});
