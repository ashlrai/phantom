import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMergeLatency, fleetMergeLatency, formatMergeLatency } from '../src/cli/fleet-merge-latency.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-02T18:00:00Z');
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const ev = (pr: number, type: string, secsAgo: number, extra: object = {}) =>
  ({ repo: 'ashlrai/phantom', pr, type, at: ago(secsAgo), ...extra });
const reader = (...rows: unknown[]) => async () => rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n');
const SHA = 'a'.repeat(40);
afterEach(() => vi.restoreAllMocks());

it('reports per-PR stages and makes missing, repeated, reversed and tied boundaries explicit', async () => {
  const report = await fleetMergeLatency(reader(
    ev(1, 'opened', 100), ev(1, 'queued', 90), ev(1, 'checks_passed', 40), ev(1, 'merged', 10),
    ev(2, 'opened', 100), ev(2, 'queued', 90), ev(2, 'merged', 10),
    ev(3, 'opened', 100), ev(3, 'queued', 90), ev(3, 'queued', 80), ev(3, 'checks_passed', 40), ev(3, 'merged', 10),
    ev(4, 'opened', 100), ev(4, 'queued', 40), ev(4, 'checks_passed', 90), ev(4, 'merged', 10),
    ev(5, 'opened', 40), ev(5, 'queued', 30), ev(5, 'checks_passed', 20), ev(5, 'merged', 10),
  ), now);
  expect(report.pr_stages).toMatchObject([
    { pr: 1, queue_wait_s: 10, required_checks_s: 50, merge_s: 30, slowest_stage: 'required_checks', missing_or_ambiguous: [], out_of_order: false },
    { pr: 2, queue_wait_s: 10, required_checks_s: null, merge_s: null, slowest_stage: null, missing_or_ambiguous: ['checks_passed'] },
    { pr: 3, queue_wait_s: null, required_checks_s: null, missing_or_ambiguous: ['queued'], slowest_stage: null },
    { pr: 4, required_checks_s: null, out_of_order: true, slowest_stage: null },
    { pr: 5, slowest_stage: null, missing_or_ambiguous: [] },
  ]);
  expect(formatMergeLatency(report)).toContain('missing or ambiguous: checks_passed');
  expect(formatMergeLatency(report)).toContain('timestamps out of order');
});

/** A PR that opened `open` s ago, queued after `q` s and merged `m` s after queueing. */
const merged = (pr: number, q: number, m: number) =>
  [ev(pr, 'opened', 1000), ev(pr, 'queued', 1000 - q), ev(pr, 'merged', 1000 - q - m)];

it('measures queue and merge delays with nearest-rank percentiles', async () => {
  // Ten merged PRs: queue wait 10..100 s, queue-to-merge 100..1000 s.
  const byPr = Array.from({ length: 10 }, (_, i) => [ev(i + 1, 'opened', 5000), ev(i + 1, 'queued', 5000 - (i + 1) * 10),
    ev(i + 1, 'merged', 5000 - (i + 1) * 10 - (i + 1) * 100)]).flat();
  const r = await fleetMergeLatency(reader(...byPr), now);
  expect(r).toMatchObject({ schema: 'fleet.merge-latency.v1', known: true, merged: 10, open: 0, slowest_step: 'queue_to_merge' });
  expect(r.opened_to_queue).toEqual({ count: 10, missing: 0, p50_s: 50, p90_s: 90, max_s: 100 });
  expect(r.queue_to_merge).toEqual({ count: 10, missing: 0, p50_s: 500, p90_s: 900, max_s: 1000 });
  expect(r.total).toMatchObject({ p50_s: 550, p90_s: 990, max_s: 1100 });
});

it('counts missing events instead of guessing', async () => {
  const r = await fleetMergeLatency(reader(
    ev(1, 'opened', 500), ev(1, 'merged', 100),                 // never queued
    ev(2, 'queued', 400), ev(2, 'merged', 300),                 // never opened
    ev(3, 'opened', 300), ev(3, 'queued', 200), ev(3, 'merged', 250), // merged before queued: out of order
  ), now);
  expect(r.merged).toBe(3);
  expect(r.opened_to_queue).toEqual({ count: 1, missing: 2, p50_s: 100, p90_s: 100, max_s: 100 });
  expect(r.queue_to_merge).toMatchObject({ count: 1, missing: 2, p50_s: 100 });
  expect(r.total).toMatchObject({ count: 2, missing: 1 });
});

it('reports empty measures as null and skips bad, future and old data', async () => {
  const r = await fleetMergeLatency(reader('{broken', '[]', ev(1, 'wat', 10), { ...ev(1, 'opened', 10), pr: 0 },
    { ...ev(1, 'opened', 10), repo: 'nope' }, ev(2, 'opened', -60), ev(3, 'merged', 3 * 24 * 3600)), now);
  expect(r).toMatchObject({ known: true, merged: 0, open: 0, ignored_events: 6, slowest_step: null });
  expect(r.total).toEqual({ count: 0, missing: 0, p50_s: null, p90_s: null, max_s: null });
});

it('says unknown when events cannot be read, and an empty file is known', async () => {
  for (const read of [async () => null, async (): Promise<string> => { throw new Error('private'); }]) {
    expect(await fleetMergeLatency(read, now)).toMatchObject({ known: false, total: null, retryable_conflicts: null });
  }
  expect(await fleetMergeLatency(reader(), now)).toMatchObject({ known: true, merged: 0, retryable_conflicts: [], pending_auto_merge: [] });
});

it('finds conflicts the recut loop can retry, longest waiting first', async () => {
  const r = await fleetMergeLatency(reader(
    ev(7, 'opened', 900), ev(7, 'conflict', 600, { head_sha: SHA.toUpperCase() }),
    ev(8, 'opened', 900), ev(8, 'conflict', 800, { head_sha: 'b'.repeat(40) }),
  ), now);
  expect(r.retryable_conflicts?.map(c => [c.pr, c.waiting_s])).toEqual([[8, 800], [7, 600]]);
  expect(r.retryable_conflicts?.[1]).toMatchObject({ head_sha: SHA, recut: { key: `RQ-RECUT-phantom-7-${'a'.repeat(7)}`, repo: 'ashlrai/phantom', number: 7 } });
  expect(r.blocked_conflicts).toEqual([]);
});

it('leaves conflicts alone that are fixed, merged, unkeyed, already requested or retried too often', async () => {
  const r = await fleetMergeLatency(reader(
    ev(1, 'conflict', 500, { head_sha: SHA }), ev(1, 'queued', 400),                       // resolved
    ev(2, 'conflict', 500, { head_sha: SHA }), ev(2, 'merged', 400),                       // merged anyway
    ev(3, 'conflict', 500),                                                                // no head
    ev(4, 'conflict', 500, { head_sha: 'not-a-sha' }),                                     // bad head
    ev(5, 'conflict', 500, { head_sha: SHA }), ev(5, 'recut_requested', 400, { head_sha: SHA }),
    ev(6, 'recut_requested', 900, { head_sha: 'c'.repeat(40) }), ev(6, 'recut_requested', 800), ev(6, 'recut_requested', 700),
    ev(6, 'conflict', 500, { head_sha: SHA }),
    ev(9, 'conflict', 500, { head_sha: SHA }), ev(9, 'recut_requested', 400, { head_sha: 'd'.repeat(40) }), // new head: not asked yet
  ), now);
  expect(r.retryable_conflicts?.map(c => c.pr)).toEqual([9]);
  expect(r.blocked_conflicts).toEqual([
    { repo: 'ashlrai/phantom', pr: 3, reason: 'no-head' }, { repo: 'ashlrai/phantom', pr: 4, reason: 'no-head' },
    { repo: 'ashlrai/phantom', pr: 5, reason: 'already-requested' }, { repo: 'ashlrai/phantom', pr: 6, reason: 'too-many-recuts' },
  ]);
});

it('keeps repos with the same PR number apart', async () => {
  const r = await fleetMergeLatency(reader(
    { ...ev(1, 'conflict', 300, { head_sha: SHA }), repo: 'ashlrai/one' },
    { ...ev(1, 'merged', 100), repo: 'ashlrai/two' },
  ), now);
  expect(r.retryable_conflicts?.map(c => c.repo)).toEqual(['ashlrai/one']);
  expect(r.merged).toBe(1);
});

it('prints plain words, typed JSON, and rejects bad options', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = reader(...merged(1, 60, 600), ev(2, 'conflict', 300, { head_sha: SHA }), ev(3, 'conflict', 300));
  expect(await cmdFleetMergeLatency(['--json'], { read, now })).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.merge-latency.v1', merged: 1, open: 2 });
  expect(await cmdFleetMergeLatency([], { read, now })).toBe(0);
  const text = log.mock.calls[1]![0] as string;
  expect(text).toContain('Queue to merge: median 600s');
  expect(text).toContain('Slowest step: queue to merge.');
  expect(text).toContain('#2 (RQ-RECUT-phantom-2-aaaaaaa)');
  expect(text).toContain('Needs a person: #3 (no-head)');
  expect(formatMergeLatency(await fleetMergeLatency(async () => null, now))).toBe('Merge latency: unknown (events unreadable)');
  for (const bad of [['--hours', '0'], ['--hours', '99999'], ['--events'], ['--json', '--json'], ['--nope']]) {
    expect(await cmdFleetMergeLatency(bad, { read, now })).toBe(2);
  }
  expect(error).toHaveBeenCalledTimes(5);
  expect(await cmdFleetMergeLatency(['--help'])).toBe(0);
});

it('is reachable as `ashlr fleet merge-latency`', async () => {
  const mod = await FLEET_SUBCOMMAND_LOADERS['merge-latency']!();
  expect(typeof mod.cmdFleetMergeLatency).toBe('function');
});

it('finds stalled auto-merges of any age without inferring enablement from queue entry', async () => {
  const rows = [ev(1, 'auto_merge_enabled', 3600), ev(2, 'auto_merge_enabled', 3599.9),
    ev(3, 'auto_merge_enabled', 3 * 24 * 3600), ev(4, 'queued', 9000),
    ev(5, 'auto_merge_enabled', 8000), ev(5, 'merged', 10), ev(6, 'auto_merge_enabled', 8000), ev(6, 'closed', 10),
    ev(7, 'auto_merge_enabled', 8000), ev(7, 'auto_merge_disabled', 500),
    ev(8, 'auto_merge_enabled', 8000), ev(8, 'auto_merge_disabled', 500), ev(8, 'auto_merge_enabled', 20),
    { ...ev(1, 'auto_merge_enabled', 7200), repo: 'ashlrai/other' }];
  const r = await fleetMergeLatency(reader(...rows.reverse()), now, 1);
  expect(r.pending_auto_merge).toEqual([
    { repo: 'ashlrai/phantom', pr: 3, auto_merge: 'enabled', waiting_s: 259200, stalled: true },
    { repo: 'ashlrai/other', pr: 1, auto_merge: 'enabled', waiting_s: 7200, stalled: true },
    { repo: 'ashlrai/phantom', pr: 1, auto_merge: 'enabled', waiting_s: 3600, stalled: true },
    { repo: 'ashlrai/phantom', pr: 2, auto_merge: 'enabled', waiting_s: 3599, stalled: false },
    { repo: 'ashlrai/phantom', pr: 8, auto_merge: 'enabled', waiting_s: 20, stalled: false },
  ]);
  expect(r.queue_to_merge).toMatchObject({ count: 0, missing: 1, p50_s: null });
});

it('keeps missing state times and contradictory auto-merge evidence unknown', async () => {
  const r = await fleetMergeLatency(reader(
    { ...ev(1, 'auto_merge_enabled', 100), at: undefined },
    ev(2, 'auto_merge_enabled', 8000), { ...ev(2, 'auto_merge_disabled', 100), at: null },
    ev(3, 'auto_merge_enabled', 8000), { ...ev(3, 'auto_merge_enabled', 100), at: 'bad' },
    ev(4, 'auto_merge_enabled', 8000), ev(4, 'auto_merge_disabled', 8000),
    ev(5, 'auto_merge_enabled', 8000), { ...ev(5, 'merged', 10), at: undefined },
    ev(6, 'auto_merge_enabled', 8000), { ...ev(6, 'closed', 10), at: undefined },
    ev(7, 'auto_merge_disabled', 8000), ev(7, 'auto_merge_enabled', 8000), // reversed simultaneous events
  ), now);
  expect(r.pending_auto_merge?.map(p => [p.pr, p.auto_merge, p.waiting_s, p.stalled])).toEqual([
    [1, 'enabled', null, null], [2, 'unknown', null, null], [3, 'enabled', null, null], [4, 'unknown', null, null], [7, 'unknown', null, null],
  ]);
  expect(r).toMatchObject({ merged: 1, merged_time_unknown: 1, queue_to_merge: { count: 0, missing: 1, p50_s: null } });
  expect(formatMergeLatency(r)).toContain('0 merged; 1 merged at an unknown time');
  expect((await fleetMergeLatency(async () => null, now)).pending_auto_merge).toBeNull();
});

it('limits merged percentiles to merge time, retains first-enqueue wall latency, and excludes pending ages', async () => {
  const r = await fleetMergeLatency(reader(ev(1, 'queued', 9000), ev(1, 'queued', 5000), ev(1, 'merged', 100),
    ev(2, 'queued', 9000), ev(2, 'merged', 8000), ev(2, 'checks_passed', 10),
    ev(3, 'auto_merge_enabled', 8000), ev(3, 'queued', 7000)), now, 1);
  expect(r).toMatchObject({ merged: 1, queue_to_merge: { count: 1, missing: 0, p50_s: 8900, p90_s: 8900 } });
});

it('exposes configurable stall diagnostics in JSON, plain output and help, rejecting invalid flags before reads', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = vi.fn(reader(ev(1, 'auto_merge_enabled', 60), { ...ev(2, 'auto_merge_enabled', 10), at: undefined }));
  expect(await cmdFleetMergeLatency(['--stalled-after', '60', '--json'], { read, now })).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ stalled_after_s: 60,
    pending_auto_merge: [{ pr: 1, stalled: true }, { pr: 2, stalled: null }] });
  expect(await cmdFleetMergeLatency(['--stalled-after', '60'], { read, now })).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('ashlrai/phantom#1: stalled auto-merge, 60s waiting');
  expect(log.mock.calls.at(-1)![0]).toContain('auto-merge wait unknown (missing timestamp)');
  expect(log.mock.calls.at(-1)![0]).toContain('keep required checks in place');
  read.mockClear();
  for (const args of [['--stalled-after'], ['--stalled-after', '0'], ['--stalled-after', '-1'],
    ['--stalled-after', '1.5'], ['--stalled-after', 'Infinity'], ['--stalled-after', '100000000'],
    ['--stalled-after', '60', '--stalled-after', '60'], ['--events', '--json']]) {
    expect(await cmdFleetMergeLatency(args, { read, now })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
  expect(await cmdFleetMergeLatency(['--help'])).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('auto_merge_enabled');
});

it('records queue observations and attributes only unambiguous eligibility intervals', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordMergeEvent } = await import('../src/cli/fleet-merge-latency.js');
  const dir = await mkdtemp(join(tmpdir(), 'merge-observation-'));
  const path = join(dir, 'events.jsonl');
  try {
    for (const row of [ev(1, 'queued', 100), ev(1, 'blocked', 90, { reason: 'required_checks' }),
      ev(1, 'eligible', 40), ev(1, 'merged', 10)]) await recordMergeEvent(path, row);
    await expect(recordMergeEvent(path, ev(1, 'blocked', 20, { reason: 'arbitrary text' }))).rejects.toThrow();
    const text = await readFile(path, 'utf8');
    const report = await fleetMergeLatency(async () => text, now);
    expect(report.queue_timelines).toMatchObject([{ enqueue_to_eligible_s: 60, eligible_to_merge_s: 30,
      blocked: [{ reason: 'required_checks', at: ago(90) }] }]);
    const ambiguous = await fleetMergeLatency(reader(...text.trim().split('\n'), ev(1, 'blocked', 20, { reason: 'review' })), now);
    expect(ambiguous.queue_timelines?.[0]).toMatchObject({ enqueue_to_eligible_s: null, eligible_to_merge_s: null });
    const repeated = await fleetMergeLatency(reader(...text.trim().split('\n'), ev(1, 'queued', 80)), now);
    expect(repeated.queue_timelines?.[0]).toMatchObject({ enqueued_at: null, enqueue_to_eligible_s: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('reports observed check failures and queue wait by reason without guessing missing evidence', async () => {
  const report = await fleetMergeLatency(reader(
    ev(1, 'queued', 100), ev(1, 'blocked', 100, { reason: 'queue' }),
    ev(1, 'check_observed', 90, { conclusion: 'failure', required: false }),
    ev(1, 'blocked', 80, { reason: 'required_checks' }), ev(1, 'eligible', 40), ev(1, 'merged', 10),
    ev(2, 'queued', 100), ev(2, 'blocked', 100, { reason: 'required_checks' }),
    ev(2, 'check_observed', 80, { conclusion: 'failure', required: true }),
    ev(3, 'queued', 100), ev(3, 'check_observed', 80, { conclusion: 'failure' }), ev(3, 'merged', 10),
    ev(4, 'queued', 100), ev(4, 'merged', 10),
  ), now);
  expect(report.queue_timelines).toMatchObject([
    { pr: 1, wait_by_reason_s: { queue: 20, required_checks: 40 }, checks: { required_failures: 0, unrelated_failures: 1, unknown_failures: 0 } },
    { pr: 2, wait_by_reason_s: null, checks: { required_failures: 1, unrelated_failures: 0, unknown_failures: 0 } },
    { pr: 3, wait_by_reason_s: null, checks: { required_failures: 0, unrelated_failures: 0, unknown_failures: 1 } },
    { pr: 4, wait_by_reason_s: null, checks: null },
  ]);
});

it('reports current dwell only for a single observed enqueue on an open PR', async () => {
  const report = await fleetMergeLatency(reader(ev(1, 'queued', 100), ev(2, 'queued', 90), ev(2, 'queued', 50),
    ev(3, 'queued', 80), ev(3, 'merged', 10), ev(4, 'queued', 70), ev(4, 'closed', 10)), now);
  expect(report.queue_timelines?.map(t => [t.pr, t.current_dwell_s])).toEqual([[1, 100], [2, null], [3, null], [4, null]]);
});

it('classifies transient queue failures: retryable, unattributed, attributed elsewhere, or resolved', async () => {
  const report = await fleetMergeLatency(reader(
    ev(1, 'auto_merge_enabled', 900), ev(1, 'blocked', 800, { reason: 'queue' }), ev(1, 'auto_merge_disabled', 700, { head_sha: SHA }),
    ev(2, 'auto_merge_enabled', 900), ev(2, 'auto_merge_disabled', 700),                                  // no blocker evidence
    ev(3, 'auto_merge_disabled', 700),                                                                    // never enabled
    ev(4, 'auto_merge_enabled', 900), ev(4, 'blocked', 800, { reason: 'conflict' }), ev(4, 'auto_merge_disabled', 700),
    ev(5, 'auto_merge_enabled', 900), ev(5, 'blocked', 800, { reason: 'queue' }), ev(5, 'auto_merge_disabled', 700), ev(5, 'merged', 10),
    ev(6, 'auto_merge_enabled', 900), ev(6, 'blocked', 800, { reason: 'queue' }), ev(6, 'auto_merge_disabled', 700), ev(6, 'closed', 10),
    ev(7, 'auto_merge_enabled', 900), ev(7, 'blocked', 800, { reason: 'queue' }), ev(7, 'auto_merge_disabled', 700), ev(7, 'auto_merge_enabled', 100),
    ev(8, 'auto_merge_enabled', 900), ev(8, 'blocked', 800, { reason: 'queue' }), ev(8, 'auto_merge_disabled', 700), ev(8, 'blocked', 600, { reason: 'required_checks' }),
    ev(9, 'auto_merge_enabled', 900), ev(9, 'blocked', 100, { reason: 'queue' }), ev(9, 'auto_merge_disabled', 200), // late-recorded evidence still attributes
    ev(10, 'auto_merge_enabled', 900), ev(10, 'blocked', 800, { reason: 'queue' }), ev(10, 'auto_merge_disabled', 700), { ...ev(10, 'auto_merge_enabled', 100), at: undefined }, // untimed toggle: armed state unknown
  ), now);
  expect(report.queue_retries?.retryable).toEqual([
    { repo: 'ashlrai/phantom', pr: 1, disabled_at: ago(700), waiting_s: 700, head_sha: SHA, retries_used: 0, retries_left: 3, requests_failed: 0 },
    { repo: 'ashlrai/phantom', pr: 9, disabled_at: ago(200), waiting_s: 200, head_sha: null, retries_used: 0, retries_left: 3, requests_failed: 0 },
  ]);
  expect(report.queue_retries?.needs_person).toEqual([
    { repo: 'ashlrai/phantom', pr: 2, reason: 'unattributed', retries_used: 0, requests_failed: 0 },
    { repo: 'ashlrai/phantom', pr: 3, reason: 'unattributed', retries_used: 0, requests_failed: 0 },
    { repo: 'ashlrai/phantom', pr: 10, reason: 'unattributed', retries_used: 0, requests_failed: 0 },
  ]);
  expect(formatMergeLatency(report)).toContain('merge-retry');
  expect(formatMergeLatency(report)).toContain('auto-merge dropped, unattributed');
});

it('bounds retries, dedupes identical retry events, and marks a retry for this disable already-requested', async () => {
  const report = await fleetMergeLatency(reader(
    // Two retries already spent; one left.
    ev(1, 'auto_merge_enabled', 900), ev(1, 'blocked', 800, { reason: 'queue' }), ev(1, 'auto_merge_disabled', 700),
    ev(1, 'retry_requested', 950, { head_sha: SHA }), ev(1, 'retry_requested', 850, { head_sha: SHA }),
    // Three distinct retries spent before this disable: exhausted even though none answered it.
    ev(2, 'auto_merge_enabled', 900), ev(2, 'blocked', 800, { reason: 'queue' }), ev(2, 'auto_merge_disabled', 100),
    ev(2, 'retry_requested', 950), ev(2, 'retry_requested', 850), ev(2, 'retry_requested', 750),
    // The same retry_requested line replayed three times counts once.
    ev(3, 'auto_merge_enabled', 900), ev(3, 'blocked', 800, { reason: 'queue' }), ev(3, 'auto_merge_disabled', 700),
    ev(3, 'retry_requested', 950, { head_sha: SHA }), ev(3, 'retry_requested', 950, { head_sha: SHA }), ev(3, 'retry_requested', 950, { head_sha: SHA.toUpperCase() }),
    // A retry recorded at/after the disable is in flight.
    ev(4, 'auto_merge_enabled', 900), ev(4, 'blocked', 800, { reason: 'queue' }), ev(4, 'auto_merge_disabled', 700),
    ev(4, 'retry_requested', 600, { head_sha: SHA }),
  ), now);
  expect(report.queue_retries?.retryable).toMatchObject([
    { pr: 1, retries_used: 2, retries_left: 1 }, { pr: 3, retries_used: 1, retries_left: 2 },
  ]);
  expect(report.queue_retries?.needs_person).toEqual([
    { repo: 'ashlrai/phantom', pr: 2, reason: 'too-many-retries', retries_used: 3, requests_failed: 0 },
    { repo: 'ashlrai/phantom', pr: 4, reason: 'already-requested', retries_used: 1, requests_failed: 0 },
  ]);
});

it('bounds failed submissions, dedupes replayed retry_failed lines, and never counts a failure as in-flight', async () => {
  const report = await fleetMergeLatency(reader(
    // One failed submission at/after the disable: transient — still retryable, not already-requested.
    ev(1, 'auto_merge_enabled', 900), ev(1, 'blocked', 800, { reason: 'queue' }), ev(1, 'auto_merge_disabled', 700),
    ev(1, 'retry_failed', 600, { head_sha: SHA }),
    // Three distinct failed submissions: a permanent failure a person must look at.
    ev(2, 'auto_merge_enabled', 900), ev(2, 'blocked', 800, { reason: 'queue' }), ev(2, 'auto_merge_disabled', 700),
    ev(2, 'retry_failed', 600, { head_sha: SHA }), ev(2, 'retry_failed', 500, { head_sha: SHA }), ev(2, 'retry_failed', 400),
    // The same retry_failed line replayed three times counts once.
    ev(3, 'auto_merge_enabled', 900), ev(3, 'blocked', 800, { reason: 'queue' }), ev(3, 'auto_merge_disabled', 700),
    ev(3, 'retry_failed', 600, { head_sha: SHA }), ev(3, 'retry_failed', 600, { head_sha: SHA }), ev(3, 'retry_failed', 600, { head_sha: SHA.toUpperCase() }),
  ), now);
  expect(report.queue_retries?.retryable).toEqual([
    { repo: 'ashlrai/phantom', pr: 1, disabled_at: ago(700), waiting_s: 700, head_sha: SHA, retries_used: 0, retries_left: 3, requests_failed: 1 },
    // head_sha is the newest recorded head verbatim; dedupe ignores case.
    { repo: 'ashlrai/phantom', pr: 3, disabled_at: ago(700), waiting_s: 700, head_sha: SHA.toUpperCase(), retries_used: 0, retries_left: 3, requests_failed: 1 },
  ]);
  expect(report.queue_retries?.needs_person).toEqual([
    { repo: 'ashlrai/phantom', pr: 2, reason: 'request-failed', retries_used: 0, requests_failed: 3 },
  ]);
});

it('rolls up measured time in each queue state across PRs, keeping unmeasurable spans missing', async () => {
  const report = await fleetMergeLatency(reader(
    // Measurable: queue 200s then required_checks 200s before eligibility; 500s eligible to merge.
    ev(1, 'queued', 1000), ev(1, 'blocked', 1000, { reason: 'queue' }), ev(1, 'blocked', 800, { reason: 'required_checks' }),
    ev(1, 'eligible', 600), ev(1, 'merged', 100),
    // Measurable: 200s blocked on review; 200s queued; 200s eligible to merge.
    ev(2, 'queued', 500), ev(2, 'blocked', 500, { reason: 'review' }), ev(2, 'eligible', 300), ev(2, 'merged', 100),
    // Open with only an enqueue: dwell only.
    ev(3, 'queued', 300),
    // Open after eligibility: measurable blocked time and dwell, no merged spans.
    ev(4, 'queued', 400), ev(4, 'blocked', 400, { reason: 'conflict' }), ev(4, 'eligible', 200),
  ), now);
  expect(report.queue_state_time).toEqual({
    enqueue_to_eligible: { count: 2, missing: 2, p50_s: 200, p90_s: 400, max_s: 400 },
    eligible_to_merge: { count: 2, missing: 2, p50_s: 200, p90_s: 500, max_s: 500 },
    open_dwell: { count: 2, missing: 2, p50_s: 300, p90_s: 400, max_s: 400 },
    blocked: {
      required_checks: { count: 3, missing: 1, p50_s: 0, p90_s: 200, max_s: 200 },
      review: { count: 3, missing: 1, p50_s: 0, p90_s: 200, max_s: 200 },
      conflict: { count: 3, missing: 1, p50_s: 0, p90_s: 200, max_s: 200 },
      queue: { count: 3, missing: 1, p50_s: 0, p90_s: 200, max_s: 200 },
      other: { count: 3, missing: 1, p50_s: 0, p90_s: 0, max_s: 0 },
    },
  });
  const text = formatMergeLatency(report);
  expect(text).toContain('Time in each queue state: queued median 200s across 2 PRs (2 unmeasured)');
  expect(text).toContain('blocked on required checks median 0s across 3 PRs (1 unmeasured)');
  const empty = await fleetMergeLatency(reader(), now);
  expect(empty.queue_state_time?.enqueue_to_eligible).toEqual({ count: 0, missing: 0, p50_s: null, p90_s: null, max_s: null });
  expect(formatMergeLatency(empty)).toContain('Time in each queue state: unknown (no measured spans).');
});

it('records retry_requested observations through the append and --record paths', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordMergeEvent } = await import('../src/cli/fleet-merge-latency.js');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const dir = await mkdtemp(join(tmpdir(), 'merge-retry-event-'));
  const path = join(dir, 'events.jsonl');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, [ev(1, 'auto_merge_enabled', 900), ev(1, 'blocked', 800, { reason: 'queue' }),
      ev(1, 'auto_merge_disabled', 700)].map(r => JSON.stringify(r)).join('\n') + '\n');
    await recordMergeEvent(path, ev(1, 'retry_requested', 600, { head_sha: SHA }));
    expect(await cmdFleetMergeLatency(['--events', path, '--record', JSON.stringify(ev(2, 'retry_requested', 500))], { now })).toBe(0);
    expect(log).toHaveBeenCalledWith('Merge observation recorded.');
    const report = await fleetMergeLatency(async () => readFile(path, 'utf8'), now);
    expect(report.queue_retries?.needs_person).toEqual([{ repo: 'ashlrai/phantom', pr: 1, reason: 'already-requested', retries_used: 1, requests_failed: 0 }]);
    expect(await cmdFleetMergeLatency(['--events', path, '--record', JSON.stringify(ev(2, 'retry_failed', 400, { head_sha: SHA }))], { now })).toBe(0);
    expect(await readFile(path, 'utf8')).toContain('"type":"retry_failed"');
    await expect(recordMergeEvent(path, { ...ev(3, 'retry_requested', 500), at: undefined })).rejects.toThrow();
    await expect(recordMergeEvent(path, { ...ev(3, 'retry_failed', 500), at: undefined })).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
