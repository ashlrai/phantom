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
