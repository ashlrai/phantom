import { describe, expect, it } from 'vitest';
import { mergeSpeedLines } from './merge-speed-lines.js';

const now = Date.parse('2026-11-01T04:10:00Z');
const minute = 60_000;

describe('mergeSpeedLines', () => {
  it('shows nothing without a snapshot', () => {
    for (const value of [null, undefined, 'bad', []]) expect(mergeSpeedLines(value, now)).toEqual([]);
  });

  it('shows the count without a median when none is available', () => {
    expect(mergeSpeedLines({ mergesLastHour: { count: 2, items: [] } }, now))
      .toEqual([{ text: '2 merged in the last hour', tone: 'ok' }]);
  });

  it('uses the supplied median and formats minutes or hours', () => {
    for (const [ms, text] of [[42 * minute, '42m'], [90 * minute, '1.5h'], [123 * minute, '2.0h']] as const) {
      expect(mergeSpeedLines({ mergesLastHour: { count: 1, medianOpenToMergeMs: ms, items: [{ openToMergeMs: minute }] } }, now))
        .toEqual([{ text: '1 merged in the last hour', tone: 'ok' }, { text: `open→merge median ${text}`, tone: 'neutral' }]);
    }
  });

  it('computes the median from valid items when the field is unavailable', () => {
    const items = [80, 20, 40, 60].map((n) => ({ openToMergeMs: n * minute }));
    expect(mergeSpeedLines({ mergesLastHour: { count: 4, medianOpenToMergeMs: -1, items: [...items, {}, null] } }, now)[1])
      .toEqual({ text: 'open→merge median 50m', tone: 'neutral' });
    expect(mergeSpeedLines({ mergesLastHour: { count: 3, items: items.slice(0, 3) } }, now)[1])
      .toEqual({ text: 'open→merge median 40m', tone: 'neutral' });
  });

  it('warns about no merges, escalating when at least three publishes occurred', () => {
    for (const count of [0, 2]) {
      expect(mergeSpeedLines({ mergesLastHour: { count: 0 }, publishesLastHour: Array(count).fill({}) }, now))
        .toEqual([{ text: '0 merged in the last hour', tone: 'warn' }]);
    }
    for (const count of [3, 4]) {
      expect(mergeSpeedLines({ mergesLastHour: { count: 0 }, publishesLastHour: Array(count).fill({}) }, now))
        .toEqual([{ text: `0 merged, ${count} published in the last hour — merge gate stalled`, tone: 'danger' }]);
    }
  });

  it('reports an unavailable or malformed merge count without claiming a stall', () => {
    for (const mergesLastHour of [null, {}, { count: null }, { count: -1 }, { count: NaN }, { count: '0' }]) {
      expect(mergeSpeedLines({ mergesLastHour, publishesLastHour: Array(4).fill({}) }, now))
        .toEqual([{ text: 'merge count unavailable', tone: 'neutral' }]);
    }
  });
});
