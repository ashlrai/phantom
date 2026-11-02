import { expect, it } from 'vitest';
import { mergeSpeedReading } from './hub-merge-speed.js';

it.each([
  [null, { text: '—', tone: 'neutral' }],
  [{}, { text: '—', tone: 'neutral' }],
  [{ count: null }, { text: '—', tone: 'neutral' }],
  [{ count: -1 }, { text: '—', tone: 'neutral' }],
  [{ count: 0 }, { text: '0/h — nothing merged in the last hour', tone: 'warn' }],
  [{ count: 3, medianOpenToMergeMs: 42 * 60_000 }, { text: '3/h · open→merge 42m', tone: 'ok' }],
  [{ count: 2, medianOpenToMergeMs: 90 * 60_000 }, { text: '2/h · open→merge 1.5h', tone: 'ok' }],
  [{ count: 2, medianOpenToMergeMs: 100 * 60_000 }, { text: '2/h · open→merge 1.7h', tone: 'ok' }],
  [{ count: 2, items: [{ repo: 'example/repo', number: 12, title: 'Fleet view' }] }, { text: '2/h', tone: 'ok' }],
])('reads merge speed from %j', (snapshot, expected) => {
  expect(mergeSpeedReading(snapshot)).toEqual(expected);
});

it('calculates the median from valid item durations when the snapshot median is unavailable', () => {
  expect(mergeSpeedReading({ count: 4, items: [
    { openToMergeMs: 40 * 60_000 }, { openToMergeMs: 10 * 60_000 },
    { openToMergeMs: 30 * 60_000 }, { openToMergeMs: 20 * 60_000 },
    { openToMergeMs: null }, { openToMergeMs: -1 }, {}, null,
  ] })).toEqual({ text: '4/h · open→merge 25m', tone: 'ok' });
  expect(mergeSpeedReading({ count: 3, medianOpenToMergeMs: null, items: [
    { openToMergeMs: 30 * 60_000 }, { openToMergeMs: 10 * 60_000 }, { openToMergeMs: 20 * 60_000 },
  ] })).toEqual({ text: '3/h · open→merge 20m', tone: 'ok' });
  expect(mergeSpeedReading({ count: 1, items: [] })).toEqual({ text: '1/h', tone: 'ok' });
});
