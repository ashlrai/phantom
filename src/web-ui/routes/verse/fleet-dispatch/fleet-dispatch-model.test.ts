import { describe, expect, it } from 'vitest';
import { incidents } from '../command/incidents-model.js';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { laneVerdict, readDispatch, supplySummary, tickAgeMs } from './fleet-dispatch-model.js';

const nowMs = Date.parse('2026-10-31T05:09:00Z');
const ctx = { nowMs, lastTickAgeMs: 0, paused: false, claudeLane: null };
const lane = (overrides = {}) => ({ ...withLane(fleetRunsFixture(), { lane: 'codex-personal', running: 0, target: 4, queued: 17 }).lanes[0]!, ...overrides });

describe('laneVerdict', () => {
  it.each([
    [{ held: true, heldReason: 'usage limit' }, ctx, 'held', 'warn'],
    [{ lane: 'claude' }, { ...ctx, claudeLane: 'down — token rejected' }, 'down', 'danger'],
    [{}, { ...ctx, paused: true }, 'paused', 'warn'],
    [{ running: 4 }, ctx, 'at-target', 'ok'],
    [{ running: 5 }, ctx, 'over', 'warn'],
    [{}, ctx, 'filling', 'warn'],
    [{}, { ...ctx, lastTickAgeMs: 540_000 }, 'starved', 'danger'],
    [{ queued: 0 }, ctx, 'idle', 'neutral'],
  ] as const)('classifies %j as %s', (overrides, context, kind, tone) => {
    expect(laneVerdict(lane(overrides), context)).toMatchObject({ kind, tone, free: Math.max(0, 4 - lane(overrides).running) });
  });
  it.each(['usage', 'LIMIT', 'quota'])('maps %s to reset guidance', reason => {
    expect(laneVerdict(lane({ held: true, heldReason: reason }), ctx).action).toBe('Waits for the provider reset; put jobs on other lanes');
  });
  it.each(['token', 'AUTH', 'login'])('maps %s to authentication guidance', reason => {
    expect(laneVerdict(lane({ held: true, heldReason: reason }), ctx).action).toBe('Re-authenticate this lane');
  });
  it('keeps unknown holds and reasons visible', () => {
    expect(laneVerdict(lane({ held: true }), ctx)).toMatchObject({ headline: 'held — no reason given', action: null });
    expect(laneVerdict(lane({ held: true, heldReason: 'maintenance' }), ctx).action).toBeNull();
  });
  it('requires a tick older than five minutes to report starvation', () => {
    for (const lastTickAgeMs of [null, 300_000]) expect(laneVerdict(lane(), { ...ctx, lastTickAgeMs }).kind).toBe('filling');
    expect(laneVerdict(lane(), { ...ctx, lastTickAgeMs: 540_000 })).toMatchObject({ headline: '4 free, 17 queued — last tick 9 min ago', action: 'Dispatch is not launching: check the tick and lane holds' });
  });
  it('prioritizes held, down and paused before capacity', () => {
    const down = { ...ctx, paused: true, claudeLane: 'DOWN: token rejected' };
    expect(laneVerdict(lane({ lane: 'claude', held: true }), down).kind).toBe('held');
    expect(laneVerdict(lane({ lane: 'claude', running: 4 }), down)).toMatchObject({ kind: 'down', action: 'Run ~/.ashlr-runs/bin/fix-claude-lane.sh' });
    expect(laneVerdict(lane({ running: 4 }), down).kind).toBe('paused');
  });
  it('handles zero targets without negative free slots', () => {
    expect(laneVerdict(lane({ running: 1, target: 0 }), ctx)).toMatchObject({ free: 0, kind: 'idle' });
  });
});

it.each([[0, 'demand'], [5, 'supply'], [4, 'balanced'], [2, 'balanced']] as const)('summarizes %i queued as %s bound', (queued, bound) => {
  expect(supplySummary([lane({ queued })])).toMatchObject({ freeSlots: 4, queued, running: 0, target: 4, bound, text: expect.any(String) });
});
it('totals across lanes and clamps over-target capacity', () => {
  expect(supplySummary([lane(), lane({ running: 5, queued: 0 })])).toMatchObject({ freeSlots: 4, queued: 17, running: 5, target: 8, bound: 'supply' });
  expect(supplySummary([]).bound).toBe('balanced');
});
it('reads tick ages including missing, invalid and future ticks', () => {
  expect(tickAgeMs(null, nowMs)).toBeNull();
  expect(tickAgeMs('invalid', nowMs)).toBeNull();
  expect(tickAgeMs(fleetRunsFixture().lastTick, NaN)).toBeNull();
  expect(tickAgeMs(fleetRunsFixture().lastTick, nowMs)).toBe(540_000);
  expect(tickAgeMs('2026-11-01', nowMs)).toBe(0);
});
it.each([null, undefined, [], {}, { v: 1 }, { ...fleetRunsFixture(), v: 2 }, { ...fleetRunsFixture(), lanes: [null] }])('rejects malformed snapshots %j', raw => {
  expect(readDispatch(raw, nowMs)).toBeNull();
});
it('sorts by severity then lane name and reuses the stall incident', () => {
  const runs = fleetRunsFixture({ lanes: [lane({ lane: 'z', queued: 0 }), lane({ lane: 'b', held: true }), lane({ lane: 'a', held: true }), lane({ lane: 'claude' })], claudeLane: 'down', events: [{ at: '2026-10-31T04:00:00Z', kind: 'launch', text: '' }], publishesLastHour: [], mergesLastHour: { count: 0, items: [] } });
  const result = readDispatch(runs, nowMs)!;
  expect(result.verdicts.map(v => v.lane)).toEqual(['claude', 'a', 'b', 'z']);
  expect(result.incidents).toEqual(incidents(runs, nowMs).filter(item => item.id === 'stall'));
  expect(result.sourceState).toBe('healthy');
  expect(readDispatch({ ...runs, sources: { ...runs.sources, runsDir: 'degraded' } }, nowMs)?.sourceState).toBe('degraded');
});
