import { describe, expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { isFleetRuns, type FleetRuns } from '../ops/ops-runs-model.js';
import { mergesLane } from './fleet-timeline-model.js';

const from = Date.parse('2026-10-31T12:00:00Z');
const to = Date.parse('2026-10-31T13:00:00Z');
const item = (number: number, extra: { mergedAt?: string; openedAt?: string; title?: string } = {}) =>
  ({ repo: 'example/repo', number, title: 'bridge: RQ-PHX-EXAMPLE31', ...extra });
const runs = (items: ReturnType<typeof item>[]): FleetRuns => ({ ...fleetRunsFixture({ claudeLane: null }), mergesLastHour: { count: items.length, items } });

describe('mergesLane', () => {
  it('places inclusive merge times and shows waits wholly inside the window', () => {
    const result = mergesLane(runs([
      item(1, { mergedAt: '2026-10-31T12:30:00Z', openedAt: '2026-10-31T12:10:00Z' }),
      item(2, { mergedAt: '2026-10-31T12:00:00Z', openedAt: '2026-10-31T11:00:00Z', title: 'Improve the fleet' }),
      item(3, { mergedAt: '2026-10-31T13:00:00Z' }),
      item(4, { mergedAt: '2026-10-31T13:00:01Z' }),
      item(5, { mergedAt: '2026-10-31T11:59:59Z' }),
    ]), from, to);
    expect(result.unplaced).toBe(0);
    expect(result.lane?.items).toEqual([
      { id: 'merge:example/repo#2', label: '#2 Improve the fleet', start: from, end: from, status: 'merged', detail: 'example/repo · open → merge 1:00' },
      { id: 'merge:example/repo#1', label: '#1 RQ-PHX-EXAMPLE31', start: Date.parse('2026-10-31T12:10:00Z'), end: Date.parse('2026-10-31T12:30:00Z'), status: 'merged', detail: 'example/repo · open → merge 20:00' },
      { id: 'merge:example/repo#3', label: '#3 RQ-PHX-EXAMPLE31', start: to, end: to, status: 'merged', detail: 'example/repo' },
    ]);
  });

  it('counts absent and invalid merge times without counting out-of-window merges', () => {
    expect(mergesLane(runs([item(1), item(2, { mergedAt: 'bad' }), item(3, { mergedAt: '2026-10-31T11:00:00Z' })]), from, to))
      .toEqual({ lane: null, unplaced: 2 });
    expect(mergesLane(runs([]), from, to)).toEqual({ lane: null, unplaced: 0 });
  });

  it('validates optional timestamp fields while accepting older snapshots', () => {
    expect(isFleetRuns(runs([item(1), item(2, { mergedAt: '2026-10-31T12:00:00Z', openedAt: '2026-10-31T11:00:00Z' })]))).toBe(true);
    expect(isFleetRuns({ ...runs([]), mergesLastHour: { count: 1, items: [{ ...item(1), mergedAt: 123 }] } })).toBe(false);
  });
});
