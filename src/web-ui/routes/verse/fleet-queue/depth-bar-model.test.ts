import { describe, expect, it } from 'vitest';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { DEPTH_SCALE_MAX, DEPTH_TICKS, depthBar, laneDepthRows, wholeDepthRow, WHOLE_QUEUE } from './depth-bar-model.js';
import { queueDepth } from './queue-depth-model.js';

const lane = (name: string, target: number, held = false) => ({ lane: name, running: 0, target, held });
const queued = (name: string, ready: number) => ({ lane: name, ready, parked: 0 });
const holds = (...names: string[]): LaneTargetsV1 => ({ v: 1, lanes: names.map(name => ({ lane: name, held: true })) } as unknown as LaneTargetsV1);

describe('depthBar', () => {
  it('reads a pile against its slots by the 1x and 3x bounds', () => {
    expect(depthBar(20, 10)).toEqual({ state: 'measured', ratio: 2, fillPercent: 50, over: false, bounds: 'in', caption: '2x its 10 live slots · in bounds' });
    expect(depthBar(10, 10)).toMatchObject({ bounds: 'in', fillPercent: 25 });
    expect(depthBar(30, 10)).toMatchObject({ bounds: 'in', fillPercent: 75 });
    expect(depthBar(5, 10)).toMatchObject({ bounds: 'under', fillPercent: 12.5, caption: '0.5x its 10 live slots · under 1x' });
    expect(depthBar(31, 10)).toMatchObject({ bounds: 'over', over: false, caption: '3.1x its 10 live slots · over 3x' });
    expect(depthBar(1, 1).caption).toBe('1x its 1 live slot · in bounds');
  });

  it('puts its ticks exactly where the depth line changes its verdict', () => {
    const verdict = (ready: number) => queueDepth({ readyCount: ready, lanes: [lane('a', 100)], lineAgesMs: [] }).verdict;
    const [low, high] = DEPTH_TICKS;
    expect([verdict(low * 100 - 1), verdict(low * 100)]).toEqual(['thin', 'ok']);
    expect([verdict(high * 100), verdict(high * 100 + 1)]).toEqual(['ok', 'deep']);
    expect(DEPTH_SCALE_MAX).toBeGreaterThan(high);
  });

  it('fills the track and flags it when the pile is past the scale', () => {
    expect(depthBar(40, 10)).toMatchObject({ fillPercent: 100, over: false });
    expect(depthBar(270, 10)).toMatchObject({ fillPercent: 100, over: true, caption: '27x its 10 live slots · over 3x' });
  });

  it('keeps unknown, held, zero-target and empty apart', () => {
    expect(depthBar(40, null)).toMatchObject({ state: 'unknown', ratio: null, bounds: null, caption: 'live slots unknown' });
    expect(depthBar(40, Number.NaN).state).toBe('unknown');
    expect(depthBar(40, 10, true)).toMatchObject({ state: 'held', ratio: null, caption: 'held, so its slots drain nothing' });
    expect(depthBar(40, 0)).toMatchObject({ state: 'no-slots', ratio: null, caption: 'no live slots: its target is 0' });
    expect(depthBar(0, 10)).toMatchObject({ state: 'measured', ratio: 0, fillPercent: 0, bounds: 'empty', caption: 'nothing ready for its 10 live slots' });
  });
});

describe('wholeDepthRow', () => {
  it('measures the ready pile against the lanes that are not held', () => {
    expect(wholeDepthRow(77, [lane('a', 20), lane('b', 10), lane('c', 10, true)])).toEqual({
      lane: WHOLE_QUEUE, ready: 77, bar: expect.objectContaining({ state: 'measured', bounds: 'in', caption: '2.6x their 30 live slots · in bounds' }),
    });
  });

  it('says unknown without a lane read, never zero slots', () => {
    expect(wholeDepthRow(812, []).bar).toMatchObject({ state: 'unknown', ratio: null, caption: 'live slots unknown' });
  });

  it('says why nothing drains when every lane is held or has no target', () => {
    expect(wholeDepthRow(5, [lane('a', 4, true), lane('b', 6, true)]).bar).toMatchObject({ state: 'held', caption: 'every lane is held, so nothing drains' });
    expect(wholeDepthRow(5, [lane('a', 0), lane('b', 0, true)]).bar).toMatchObject({ state: 'no-slots', caption: "no live slots: every lane's target is 0" });
  });
});

describe('laneDepthRows', () => {
  it('ranks measured lanes deepest first, then held, zero-target and unknown lanes', () => {
    const rows = laneDepthRows(
      [queued('stranger', 9), queued('zero', 3), queued('held', 5), queued('thin', 2), queued('fine', 20), queued('deep', 50)],
      [lane('deep', 10), lane('fine', 10), lane('thin', 10), lane('held', 10, true), lane('zero', 0)], null);
    expect(rows.map(row => [row.lane, row.bar.state, row.bar.bounds])).toEqual([
      ['deep', 'measured', 'over'], ['fine', 'measured', 'in'], ['thin', 'measured', 'under'],
      ['held', 'held', null], ['zero', 'no-slots', null], ['stranger', 'unknown', null],
    ]);
  });

  it('counts a hold from the holds read even when the fleet snapshot does not show it', () => {
    const [row] = laneDepthRows([queued('a', 12)], [lane('a', 4)], holds('a'));
    expect(row!.bar.state).toBe('held');
  });

  it('reads every lane as unknown when the fleet snapshot is missing', () => {
    expect(laneDepthRows([queued('a', 12), queued('b', 0)], [], undefined).map(row => row.bar.state)).toEqual(['unknown', 'unknown']);
  });
});
