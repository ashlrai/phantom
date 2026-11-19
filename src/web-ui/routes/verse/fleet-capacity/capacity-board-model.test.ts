import { describe, expect, it } from 'vitest';
import type { LaneSeries } from './capacity-model.js';
import { areaPath, boardHeadline, fleetTotals, laneFacts, place, rankLanes, slotSpan, span, totalFacts, watchedMinutes, watchedSegments } from './capacity-board-model.js';

const MINUTE = 60_000;
const lane = (name: string, over: Partial<LaneSeries> = {}): LaneSeries => ({
  lane: name, fillPct: null, idleSlotMinutes: 0, heldMinutes: 0, stallMinutes: 0,
  points: [{ atMs: 0, running: 1, target: 2, queued: 3, held: false }], ...over,
});

describe('capacity board', () => {
  it('totals fill across every sample of every lane and never invents a share without a target', () => {
    const totals = fleetTotals([
      lane('a', { idleSlotMinutes: 2, heldMinutes: 1, stallMinutes: 30, points: [{ atMs: 0, running: 1, target: 2, queued: 1, held: false }, { atMs: 1, running: 2, target: 2, queued: 0, held: false }] }),
      lane('b', { idleSlotMinutes: 4, points: [{ atMs: 0, running: 0, target: 4, queued: 0, held: true }] }),
    ]);
    expect(totals).toEqual({ fillPct: 37.5, idleSlotMinutes: 6, heldMinutes: 1, stallMinutes: 30 });
    expect(boardHeadline(totals, 2)).toBe('Lanes filled 37.5% of their target slots');
    const none = fleetTotals([lane('a', { points: [{ atMs: 0, running: 0, target: 0, queued: 0, held: false }] })]);
    expect(none.fillPct).toBeNull();
    expect(boardHeadline(none, 1)).toBe('No lane had a target in this window');
    expect(boardHeadline(fleetTotals([]), 0)).toBe('No lanes reported in this window');
    expect(totalFacts(none, 0, 24)[0]).toMatchObject({ label: 'Filled', value: 'no target' });
  });

  it('puts stalled lanes first, then the most idle, then by name', () => {
    const order = rankLanes([lane('zed'), lane('idle', { idleSlotMinutes: 9 }), lane('alpha'), lane('stalled', { stallMinutes: 5 })]).map((row) => row.lane);
    expect(order).toEqual(['stalled', 'idle', 'alpha', 'zed']);
  });

  it('words durations in minutes, then hours', () => {
    expect(span(30)).toBe('30 min');
    expect(span(150)).toBe('2.5 h');
    expect(slotSpan(2)).toBe('2 slot-min');
    expect(slotSpan(180)).toBe('3 slot-h');
  });

  it('lists a lane\'s last sample and shows Stalled only when it stalled', () => {
    const calm = laneFacts(lane('a', { points: [{ atMs: 0, running: 1, target: 2, queued: 3, held: true }] }));
    expect(calm.map((fact) => fact.label)).toEqual(['Last sample', 'Idle', 'Held']);
    expect(calm[0]).toMatchObject({ value: '1 of 2', note: '3 queued · held' });
    const stalled = laneFacts(lane('a', { stallMinutes: 30 }));
    expect(stalled[3]).toEqual({ label: 'Stalled', value: '30 min', tone: 'warning', testId: 'lane-stalled' });
    expect(laneFacts(lane('a', { points: [] })).map((fact) => fact.label)).toEqual(['Idle', 'Held']);
  });

  it('counts only the time the sampler was watching', () => {
    const segments = watchedSegments([0, 2 * MINUTE, 4 * MINUTE, 30 * MINUTE, 31 * MINUTE, 90 * MINUTE]);
    expect(segments).toEqual([{ fromMs: 0, toMs: 4 * MINUTE }, { fromMs: 30 * MINUTE, toMs: 31 * MINUTE }, { fromMs: 90 * MINUTE, toMs: 90 * MINUTE }]);
    expect(watchedMinutes(segments)).toBe(5);
    expect(totalFacts(fleetTotals([]), 5, 6)[4]).toEqual({ label: 'Watched', value: '5 min', note: 'of the last 6 h' });
    expect(place({ fromMs: 30 * MINUTE, toMs: 60 * MINUTE }, 0, 120 * MINUTE)).toEqual({ left: 25, width: 25 });
    expect(place({ fromMs: -10, toMs: 500 }, 0, 100)).toEqual({ left: 0, width: 100 });
  });

  it('fills under the running line and breaks where the line breaks', () => {
    const points = [0, 1, 2, 20, 21].map((minute) => ({ atMs: minute * MINUTE, running: minute === 2 ? null : 1, target: 2 }));
    const path = areaPath(points, 210, 40);
    expect(path).toBe('M0.00,40 L0.00,20.00 L10.00,20.00 L10.00,40 Z M200.00,40 L200.00,20.00 L210.00,20.00 L210.00,40 Z');
    expect(areaPath([], 210, 40)).toBe('');
    expect(areaPath([{ atMs: 0, running: 1, target: 1 }], 210, 40)).toBe('');
  });
});
