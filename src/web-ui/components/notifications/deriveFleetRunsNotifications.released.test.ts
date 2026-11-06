import { describe, expect, it } from 'vitest';
import { deriveFleetLaneReleases as derive } from './deriveFleetRunsNotifications.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const lane = (held: boolean, extra = {}) => ({ lane: 'lane-a', held, running: 0, target: 1, queued: 7, ...extra });
const snapshot = (row: object) => ({ generatedAt: new Date(now).toISOString(), claudeLane: null,
  lanes: [row], workers: [], mergesLastHour: { count: null }, drop: null, events: [] });
const previous = snapshot(lane(true, { heldReason: 'autobackoff: usage limit', heldUntil: '2026-10-31T11:00:00Z' }));
const current = snapshot(lane(false, { changedBy: 'reset-detect' }));

describe('lane release notifications', () => {
  it('uses the reason even after expiry and gives repeated derivations the same id', () => {
    const result = derive(current, previous, null, null, now);
    expect(result).toEqual([expect.objectContaining({ id: 'fleet-lane-released-lane-a-2026-10-31T12:00:00.000Z',
      severity: 'medium', title: 'lane-a released', detail: 'by reset-detect · autobackoff: usage limit · 7 jobs can start',
      actionLabel: 'Open lanes', actionHref: expect.stringContaining('fleet-lanes') })]);
    expect(derive(current, previous, null, null, now)).toEqual(result);
  });
  it('is silent on first load and when the lane was not held', () => {
    expect(derive(current, undefined, null, null, now)).toEqual([]);
    expect(derive(current, current, null, null, now)).toEqual([]);
    expect(derive(current, { ...previous, lanes: [] }, null, null, now)).toEqual([]);
  });
  it('uses control attribution and expiry fallback, or unknown when unavailable', () => {
    const target = { lane: 'lane-a', target: 1, floor: 0, ceiling: 2, held: false, heldReason: null,
      heldUntil: null, lastChange: '2026-10-31T11:59:00Z', changedBy: 'operator' };
    const targets = { v: 1 as const, generatedAt: target.lastChange, sourceState: 'healthy' as const, lanes: [target] };
    const before = snapshot(lane(true, { heldUntil: '2026-10-31T11:00:00Z' }));
    const after = snapshot(lane(false));
    expect(derive(after, before, targets, null, now)[0]).toMatchObject({ id: `fleet-lane-released-lane-a-${target.lastChange}`,
      detail: 'by operator · hold expired · 7 jobs can start' });
    expect(derive(after, before, null, null, now)[0]?.detail).toBe('by unknown · hold expired · 7 jobs can start');
    const heldTargets = { ...targets, lanes: [{ ...target, held: true, heldUntil: '2026-10-31T11:00:00Z' }] };
    expect(derive(after, snapshot(lane(true)), targets, heldTargets, now)[0]?.detail)
      .toBe('by operator · hold expired · 7 jobs can start');
  });
});
