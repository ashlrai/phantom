import { describe, expect, it } from 'vitest';
import { buildBlocker, type BlockerInput } from '../src/core/fleet/digest-blocker.js';
import { buildStatusDigest, type StatusDigestInput } from '../src/core/leader/status-digest.js';
import type { Tick } from '../src/core/fleet/sleep-gaps.js';

const NOW = Date.parse('2026-11-19T23:00:00Z');
const MIN = 60_000;
const tick = (minAgo: number, over: Partial<Tick> = {}): Tick => ({ at: NOW - minAgo * MIN, run: false, reason: 'slots-full', ready: 3, free: 2, ...over });
const base: BlockerInput = { nowMs: NOW, ticks: [tick(50), tick(30), tick(10)], gaps: [], lanes: [], resources: [], admission: { load1: 14.2, loadMax: 12 },
  disk: { freeGb: 80, status: 'steady', freezeBelowGb: 20 } };
const gap = (minutes: number, endMinAgo: number, over: Record<string, unknown> = {}) => ({
  start: new Date(NOW - (endMinAgo + minutes) * MIN).toISOString(), end: new Date(NOW - endMinAgo * MIN).toISOString(), minutes,
  kind: 'no-tick' as const, cause: 'host-asleep' as const, lostWork: true, jobsQueued: 4, freeSlots: 2, sleptMinutes: minutes, reason: null, line: 'x', ...over });

describe('digest blocker', () => {
  it('asleep: names the sleep and its hours', () => {
    const b = buildBlocker({ ...base, gaps: [gap(360, 5)] });
    expect(b).toMatchObject({ kind: 'asleep', number: 360, as_of: '2026-11-19T23:00:00.000Z' });
    expect(b.sentence).toMatch(/^The Mac was asleep for 6 hours \(\d\d:\d\d to \d\d:\d\d\), so nothing ran\.$/);
  });

  it('asleep: ignores an old gap, an empty-queue gap and a short one', () => {
    for (const gaps of [[gap(360, 300)], [gap(360, 5, { lostWork: false })], [gap(25, 5)]]) expect(buildBlocker({ ...base, gaps }).kind).toBe('none');
  });

  it('asleep: unknown whether work waited is said so', () => {
    expect(buildBlocker({ ...base, gaps: [gap(90, 5, { lostWork: null, cause: 'unknown' })] }).sentence).toContain('whether work waited is unknown');
  });

  it('host_load: gives the load and the limit', () => {
    const ticks = [tick(40, { reason: 'load-gate' }), tick(20, { reason: 'load-gate' })];
    const b = buildBlocker({ ...base, ticks });
    expect(b).toMatchObject({ kind: 'host_load', number: 14.2, lost_launches: 4 });
    expect(b.sentence).toBe('Launches were held back by host load 2 times in the last hour; load is 14.2 against a limit of 12.');
  });

  it('host_load: unknown load stays unknown', () => {
    const b = buildBlocker({ ...base, ticks: [tick(20, { reason: 'load-gate' })], admission: null });
    expect(b).toMatchObject({ kind: 'host_load', number: null });
    expect(b.sentence).toContain('load is unknown');
    expect(b.unknown).toContain('host load');
  });

  it('queue_empty: a lane with free slots and nothing queued', () => {
    const lanes = [{ lane: 'claude', running: 5, target: 8, held: false }];
    const b = buildBlocker({ ...base, lanes, ticks: [tick(30, { run: true, reason: null, ready: 0, free: 3 }), tick(10, { run: true, reason: null, ready: 0, free: 3 })] });
    expect(b).toMatchObject({ kind: 'queue_empty', number: 3, lost_launches: 6 });
    expect(b.sentence).toContain('claude has 3 free slots and no work is waiting');
  });

  it('pool_drained: the lane at its cap with the reset time', () => {
    const resources = [{ lane: 'claude', target: 8, usedFrac: 1.02, resetAt: '2026-11-20T03:30:00Z' }, { lane: 'codex', target: 4, usedFrac: 0.4, resetAt: null }];
    const b = buildBlocker({ ...base, resources, lanes: [{ lane: 'claude', running: 0, target: 8, held: false }] });
    expect(b).toMatchObject({ kind: 'pool_drained', number: 102 });
    expect(b.sentence).toMatch(/^The claude lane is at its usage cap, so its 8 free slots cannot launch; resets at \d\d:\d\d ET\.$/);
  });

  it('pool_drained: unknown reset time', () => {
    const b = buildBlocker({ ...base, resources: [{ lane: 'zai', target: 3, usedFrac: 1, resetAt: null }] });
    expect(b.sentence).toContain('its reset time is unknown');
  });

  it('disk_low: free GB under the freeze line', () => {
    const b = buildBlocker({ ...base, disk: { freeGb: 8.2, status: 'below-threshold', freezeBelowGb: 20 } });
    expect(b).toMatchObject({ kind: 'disk_low', number: 8.2 });
    expect(b.sentence).toBe('Free disk is 8.2 GB, under the 20 GB line where lanes freeze. Run `phm host disk`.');
  });

  it('disk_low: falling but still above the line is not a blocker', () => {
    expect(buildBlocker({ ...base, disk: { freeGb: 25, status: 'falling', freezeBelowGb: 20 } }).kind).toBe('none');
  });

  it('picks the one costing the most launches', () => {
    const ticks = [tick(40, { reason: 'load-gate', free: 1 }), tick(20, { reason: 'load-gate', free: 1 })];
    const b = buildBlocker({ ...base, ticks, disk: { freeGb: 5, status: 'below-threshold', freezeBelowGb: 20 }, gaps: [gap(45, 3, { freeSlots: 1 })] });
    // asleep: 1 slot x 9 missed ticks in the hour beats load (2) and disk (2).
    expect(b.kind).toBe('asleep');
  });

  it('breaks a tie in the fixed order: asleep, disk_low, host_load, pool_drained, queue_empty', () => {
    // Every cause loses exactly 2 launches.
    const ticks = [tick(30, { reason: 'load-gate', free: 1, ready: 3 }), tick(10, { reason: 'load-gate', free: 1, ready: 3 })];
    const all: BlockerInput = { ...base, ticks, disk: { freeGb: 5, status: 'below-threshold', freezeBelowGb: 20 },
      resources: [{ lane: 'zai', target: 1, usedFrac: 1, resetAt: null }], lanes: [{ lane: 'zai', running: 0, target: 1, held: false }] };
    expect(buildBlocker(all).kind).toBe('disk_low');
    expect(buildBlocker({ ...all, disk: null }).kind).toBe('host_load');
    expect(buildBlocker({ ...all, disk: null, ticks: ticks.map(t => ({ ...t, reason: 'slots-full' })) }).kind).toBe('pool_drained');
    const idle = ticks.map(t => ({ ...t, run: true, reason: null, ready: 0 }));
    expect(buildBlocker({ ...all, disk: null, resources: [], ticks: idle }).kind).toBe('queue_empty');
    expect(buildBlocker({ ...all, gaps: [gap(35, 5, { freeSlots: 1 })], ticks: ticks.slice(0, 1) }).kind).toBe('asleep');
  });

  it('none: nothing costs launches', () => {
    expect(buildBlocker(base)).toMatchObject({ kind: 'none', number: null, lost_launches: null, sentence: 'Nothing is holding launches back.', unknown: [] });
  });

  it('none: unreadable sources are listed as unknown, not as fine', () => {
    const b = buildBlocker({ ...base, ticks: null, gaps: null, resources: null, disk: null, admission: null });
    expect(b.kind).toBe('none');
    expect(b.sentence).toBe('No blocker found, but unknown: dispatch ticks, tick gaps, pool usage, free disk, host load.');
  });
});

describe('digest first line', () => {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const input: StatusDigestInput = { installedVersion: ok('1.0.0'), publishedVersion: ok('1.0.0'), updatePending: false, mergesLastHour: ok(1), mergesLast24h: ok(2),
    lanes: ok([]), needsMason: ok(0), topP0: ok(null), gapLine: 'The Mac slept 12:33 to 18:42; 6 hours of work did not run.', diskLine: 'disk_low: 8 GB free' };

  it('opens with the blocker sentence and drops the line it repeats', () => {
    const lines = buildStatusDigest({ ...input, blocker: buildBlocker({ ...base, gaps: [gap(360, 5)] }) });
    expect(lines[0]).toMatch(/^The Mac was asleep for 6 hours/);
    expect(lines).not.toContain(input.gapLine);
    expect(lines).toContain(input.diskLine);
  });

  it('a none blocker adds no line', () => {
    expect(buildStatusDigest({ ...input, blocker: buildBlocker(base) })).toEqual(buildStatusDigest(input));
  });
});
