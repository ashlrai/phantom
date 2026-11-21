/**
 * The Queue pane's depth chart, as numbers: each lane's ready pile against the live slots that can drain it.
 * The verdict is `queueDepth`'s own, asked one lane at a time, so the chart and the pane's depth line cannot disagree.
 * Pure. A lane the supply read does not hold has unknown slots; that is never zero slots.
 */
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { queueDepth, ratioText, type QueueDepthLane } from './queue-depth-model.js';

/** The bounds `queueDepth` judges by, as tick positions. depth-bar-model.test.ts pins the two together. */
export const DEPTH_TICKS = [1, 3] as const;
/** The track runs from 0x to this many times the slots, so the ticks sit at a quarter and three quarters. */
export const DEPTH_SCALE_MAX = 4;
export const WHOLE_QUEUE = 'All lanes';

export interface DepthBarModel {
  /** measured: a ratio to draw. unknown: no slot reading. held: nothing drains. no-slots: the target is 0. */
  state: 'measured' | 'unknown' | 'held' | 'no-slots';
  ratio: number | null;
  /** 0 to 100 along the track. A pile past the scale fills it and sets `over`. */
  fillPercent: number;
  over: boolean;
  bounds: 'in' | 'under' | 'over' | 'empty' | null;
  /** The same reading in words, to sit beside the bar. */
  caption: string;
}

export interface DepthRow { lane: string; ready: number; bar: DepthBarModel }

const BOUNDS = { empty: 'empty', thin: 'under', ok: 'in', deep: 'over' } as const;
const none = { ratio: null, fillPercent: 0, over: false, bounds: null } as const;
const count = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

export function depthBar(readyCount: number, slots: number | null, held = false, whose: 'its' | 'their' = 'its'): DepthBarModel {
  const ready = count(readyCount);
  if (slots === null || !Number.isFinite(slots)) return { ...none, state: 'unknown', caption: 'live slots unknown' };
  if (held) return { ...none, state: 'held', caption: 'held, so its slots drain nothing' };
  const cap = count(slots);
  if (cap === 0) return { ...none, state: 'no-slots', caption: 'no live slots: its target is 0' };
  const ratio = ready / cap;
  const bounds = BOUNDS[queueDepth({ readyCount: ready, lanes: [{ lane: '', running: 0, target: cap, held: false }], lineAgesMs: [] }).verdict];
  const of = `${whose} ${cap} live slot${cap === 1 ? '' : 's'}`;
  const caption = bounds === 'empty' ? `nothing ready for ${of}`
    : `${ratioText(ratio)} ${of} · ${bounds === 'in' ? 'in bounds' : bounds === 'under' ? `under ${DEPTH_TICKS[0]}x` : `over ${DEPTH_TICKS[1]}x`}`;
  return { state: 'measured', ratio, fillPercent: Math.min(100, (ratio / DEPTH_SCALE_MAX) * 100), over: ratio > DEPTH_SCALE_MAX, bounds, caption };
}

/** The whole ready pile against every lane that is not held: the pane's depth line, drawn. No lane read is unknown. */
export function wholeDepthRow(readyCount: number, lanes: readonly QueueDepthLane[]): DepthRow {
  const ready = count(readyCount);
  if (lanes.length === 0) return { lane: WHOLE_QUEUE, ready, bar: depthBar(ready, null) };
  if (lanes.every(lane => lane.held)) return { lane: WHOLE_QUEUE, ready, bar: { ...none, state: 'held', caption: 'every lane is held, so nothing drains' } };
  const cap = queueDepth({ readyCount: ready, lanes, lineAgesMs: [] }).liveCap;
  const bar = depthBar(ready, cap, false, 'their');
  return { lane: WHOLE_QUEUE, ready, bar: bar.state === 'no-slots' ? { ...bar, caption: "no live slots: every lane's target is 0" } : bar };
}

const RANK: Record<DepthBarModel['state'], number> = { measured: 0, held: 1, 'no-slots': 2, unknown: 3 };

/** One row per queue lane, deepest first, then held, zero-target and unknown lanes. A hold from either read counts. */
export function laneDepthRows(byLane: FleetQueueV1['byLane'], lanes: readonly QueueDepthLane[], holds: LaneTargetsV1 | null | undefined): DepthRow[] {
  const held = new Set(holds?.lanes.filter(row => row.held).map(row => row.lane));
  return byLane.map(({ lane, ready }) => {
    const slots = lanes.find(row => row.lane === lane);
    return { lane, ready: count(ready), bar: depthBar(ready, slots ? slots.target : null, Boolean(slots?.held) || held.has(lane)) };
  }).sort((a, b) => RANK[a.bar.state] - RANK[b.bar.state] || (b.bar.ratio ?? 0) - (a.bar.ratio ?? 0) || b.ready - a.ready || a.lane.localeCompare(b.lane));
}
