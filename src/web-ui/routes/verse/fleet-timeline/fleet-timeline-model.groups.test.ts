import { expect, it, vi } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { groupByLane, laneGroupHeadline } from './fleet-timeline-model.js';
import { readGroupByLane, writeGroupByLane } from './timeline-prefs.js';

const worker = (lane: string, ageSeconds: number | null) => ({ ...fleetRunsFixture().workers[0]!, lane, ageSeconds });

it('groups workers by their actual lane, counts statuses at the existing boundaries, and orders by size', () => {
  const rows = [worker('devin', null), worker('codex', 1200), worker('codex', 1201), worker('codex', 2700), worker('codex', 2701), worker('codex', null), worker('other', 5)];
  const groups = groupByLane(rows, 100_000);
  expect(groups.map((group) => group.lane)).toEqual(['codex', 'devin', 'other']);
  expect(groups[0]).toMatchObject({ rows: rows.slice(1, 6), counts: { total: 5, slow: 2, stuck: 1, unknown: 1 }, medianAgeSeconds: 1950.5 });
  expect(groups[1]).toMatchObject({ counts: { total: 1, slow: 0, stuck: 0, unknown: 1 }, medianAgeSeconds: null });
  expect(laneGroupHeadline(groups[0]!)).toBe('codex · 5 workers · 2 slow · 1 stuck · 1 unknown · median 33 m');
  expect(laneGroupHeadline(groups[1]!)).toBe('devin · 1 worker · 1 unknown · median —');
  expect(laneGroupHeadline(groups[2]!)).toBe('other · 1 worker · median 0 m');
});

it('finds odd medians excluding unknowns and handles an empty fleet', () => {
  const rows = [worker('a', 840), worker('a', null), worker('a', 30), worker('a', 1800)];
  expect(groupByLane(rows, 0)[0]!.medianAgeSeconds).toBe(840);
  expect(laneGroupHeadline(groupByLane(rows, 0)[0]!)).toBe('a · 4 workers · 1 slow · 1 unknown · median 14 m');
  expect(groupByLane([], 0)).toEqual([]);
});

it('defaults to flat and tolerates unavailable storage', () => {
  localStorage.clear();
  expect(readGroupByLane()).toBe(false);
  writeGroupByLane(true);
  expect(readGroupByLane()).toBe(true);
  writeGroupByLane(false);
  expect(readGroupByLane()).toBe(false);
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readGroupByLane()).toBe(false);
  expect(() => writeGroupByLane(true)).not.toThrow();
  get.mockRestore(); set.mockRestore();
});
