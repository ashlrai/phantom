import { afterEach, expect, it, vi } from 'vitest';
import * as client from '../../../data/client.js';
import { LANE_HOLDS_PATH } from '../fleet-lanes/lane-hold-release.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { heldLaneLine, laneHoldsQuery, queuedBehindHold } from './queue-holds-model.js';

const now = Date.parse('2026-10-31T19:00:00Z');
const row: LaneTargetRow = {
  lane: 'codex-personal', target: 4, floor: 0, ceiling: 8, held: true,
  heldReason: 'autobackoff', heldUntil: '2026-10-31T20:12:00Z',
  lastChange: null, changedBy: null,
};

it('describes timed, indefinite, expired and unheld lanes', () => {
  expect(heldLaneLine(row, now)).toBe('held: autobackoff · clears in 1 h 12 min');
  expect(heldLaneLine({ ...row, heldUntil: null }, now)).toBe('held: autobackoff · no end set');
  expect(heldLaneLine({ ...row, heldUntil: 'invalid', heldReason: null }, now)).toBe('held: reason unavailable · no end set');
  expect(heldLaneLine({ ...row, heldUntil: '2026-10-31T18:00:00Z' }, now)).toBe('held: autobackoff · clears in 0 min');
  expect(heldLaneLine({ ...row, held: false }, now)).toBeNull();
  expect(heldLaneLine(undefined, now)).toBeNull();
});

it('counts ready queue lines only on held lanes', () => {
  const holds: LaneTargetsV1 = { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [row, { ...row, lane: 'devin', held: false }] };
  const groups = [{ lane: row.lane, ready: 12, parked: 3 }, { lane: 'devin', ready: 4, parked: 0 }, { lane: 'unknown', ready: 2, parked: 0 }];
  expect(queuedBehindHold(groups, holds)).toBe(12);
  expect(queuedBehindHold(groups, null)).toBe(0);
  expect(queuedBehindHold([], holds)).toBe(0);
});


afterEach(() => { vi.restoreAllMocks(); });

it('validates hold responses and treats an unavailable endpoint as absent', async () => {
  const get = vi.spyOn(client, 'apiGet');
  const data: LaneTargetsV1 = { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [row] };
  get.mockResolvedValueOnce(data).mockResolvedValueOnce({ lanes: [] })
    .mockRejectedValueOnce(new client.ApiError('missing', 404, LANE_HOLDS_PATH));
  await expect(laneHoldsQuery.fetch()).resolves.toEqual(data);
  expect(get).toHaveBeenCalledWith(LANE_HOLDS_PATH, undefined);
  await expect(laneHoldsQuery.fetch()).rejects.toThrow('Invalid lane holds response.');
  await expect(laneHoldsQuery.fetch()).resolves.toBeNull();
});
