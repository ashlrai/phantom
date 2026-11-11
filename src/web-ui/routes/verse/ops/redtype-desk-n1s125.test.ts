import { expect, it } from 'vitest';
import { laneBacklogHint } from './lane-backlog-hint.js';
import type { LaneTargetRow } from './lane-targets-model.js';

it('only suggests a bounded raise once the backlog reaches the threshold', () => {
  const lane: LaneTargetRow = { lane: 'work', target: 2, floor: 0, ceiling: 4, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
  expect(laneBacklogHint(lane, { running: 2, queued: 5 }).raiseTo).toBeNull();
  expect(laneBacklogHint(lane, { running: 2, queued: 6 })).toEqual({ line: 'running 2 of 2 · 6 waiting', raiseTo: 4 });
  expect(laneBacklogHint({ ...lane, held: true }, { running: 2, queued: 6 }).raiseTo).toBeNull();
});
