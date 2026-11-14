import { expect, it } from 'vitest';
import { laneBacklogHint } from './lane-backlog-hint.js';
import type { LaneTargetRow } from './lane-targets-model.js';

const row: LaneTargetRow = { lane: 'lane-a', target: 1, floor: 0, ceiling: 6, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };

it('stays unknown without runs', () => {
  expect(laneBacklogHint(row, null)).toEqual({ line: null, raiseTo: null });
});
it('suggests the ceiling for a deep backlog', () => {
  expect(laneBacklogHint(row, { running: 1, queued: 139 })).toEqual({ line: 'running 1 of 1 · 139 waiting', raiseTo: 6 });
});
it('suggests a partial raise and omits the waiting part at zero', () => {
  expect(laneBacklogHint(row, { running: 1, queued: 6 }).raiseTo).toBe(3);
  expect(laneBacklogHint(row, { running: 0, queued: 0 })).toEqual({ line: 'running 0 of 1', raiseTo: null });
});
it('never raises a held lane', () => {
  expect(laneBacklogHint({ ...row, held: true }, { running: 0, queued: 50 }).raiseTo).toBeNull();
});
it('does not raise for a small backlog', () => {
  expect(laneBacklogHint(row, { running: 1, queued: 2 }).raiseTo).toBeNull();
  expect(laneBacklogHint({ ...row, target: 2 }, { running: 2, queued: 5 }).raiseTo).toBeNull();
});
it('does not raise at the ceiling', () => {
  expect(laneBacklogHint({ ...row, target: 6 }, { running: 6, queued: 99 }).raiseTo).toBeNull();
});
