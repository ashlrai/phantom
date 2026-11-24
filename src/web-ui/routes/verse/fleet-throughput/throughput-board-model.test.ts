import { expect, it } from 'vitest';
import type { ThroughputCounts, ThroughputGroup, ThroughputHour, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { emptyText, figures, laneRows, peakHour, span } from './throughput-board-model.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const hour = (i: number, counts: Partial<ThroughputCounts>, base = ZERO): ThroughputHour => ({ start: new Date(Date.UTC(2026, 10, 17, 6 + i)).toISOString(), ...base, ...counts });
const report = (totals: ThroughputCounts, buckets: ThroughputHour[]): ThroughputReport => ({
  schema: 'throughput.v1', as_of: '2026-11-17T09:00:00.000Z', since: '2026-11-17T06:00:00.000Z', hours: 3, by: 'lane', metrics_path: '/fake/jobs.jsonl',
  metrics: 'ok', malformed_lines: 0, main: 'unknown', headline: '', totals, buckets, groups: [],
});
const group = (name: string, totals: Partial<ThroughputCounts>, base = ZERO): ThroughputGroup => ({ name, totals: { ...base, ...totals }, buckets: [hour(0, {}, base), hour(1, { merged: totals.merged ?? base.merged }, base)] });

it('writes a merge time the way the headline does', () => {
  expect([span(50), span(170), span(3840), span(0)]).toEqual(['50s', '2m 50s', '1h 4m', '0s']);
  expect([span(null), span(Number.NaN), span(-1)]).toEqual(['unknown', 'unknown', 'unknown']);
});

it('names the hour with the most, the latest on a tie, and none when nothing happened', () => {
  const hours = [hour(0, { merged: 4 }), hour(1, { merged: 4 }), hour(2, { merged: null })];
  expect(peakHour(hours, h => h.merged)).toEqual({ value: 4, start: hours[1]!.start });
  expect(peakHour([hour(0, {}), hour(1, {})], h => h.merged)).toBeNull();
  expect(peakHour([hour(0, {}, NONE)], h => h.merged)).toBeNull();
});

it('keeps "no job finished" apart from a 0% rate and from an unknown one', () => {
  expect(emptyText({ ...ZERO, finished: 40, empty: 0, empty_rate: 0 })).toBe('0 of 40 (0%)');
  expect(emptyText({ ...ZERO, finished: 8, empty: 2, empty_rate: 0.25 })).toBe('2 of 8 (25%)');
  expect(emptyText(ZERO)).toBe('none finished');
  expect(emptyText(NONE)).toBe('unknown');
});

it('gives each figure the report\'s own total and one point per hour', () => {
  const totals: ThroughputCounts = { launched: 9, published: 7, merged: 6, finished: 8, empty: 2, empty_rate: 0.25, median_publish_to_merge_s: 170, merge_time_unknown: 0 };
  const buckets = [hour(0, { launched: 4, merged: 1, empty: 2 }), hour(1, { launched: 5, published: 7, merged: 5, median_publish_to_merge_s: 170 }), hour(2, {})];
  const [launched, published, merged, empty, median] = figures(report(totals, buckets));
  expect([launched!.value, published!.value, merged!.value, empty!.value, median!.value]).toEqual(['9', '7', '6', '25%', '2m 50s']);
  expect(launched!.trend).toEqual([4, 5, 0]);
  expect(merged!.peak).toEqual({ value: 5, start: buckets[1]!.start });
  expect(published!.peak).toEqual({ value: 7, start: buckets[1]!.start });
  expect(empty!.caption).toBe('2 of 8 finished jobs');
  // Hours with no timed merge are gaps in the line, not zero minutes.
  expect(median!.trend).toEqual([null, 2.8, null]);
});

it('says unknown and draws no line when the report holds no counts', () => {
  for (const figure of figures(report(NONE, [hour(0, {}, NONE), hour(1, {}, NONE)]))) {
    expect([figure.id, figure.value, figure.known, figure.trend, figure.peak, figure.caption]).toEqual([figure.id, 'unknown', false, null, null, null]);
  }
});

it('words a quiet window as measured, not as unknown', () => {
  const [, , merged, empty, median] = figures(report(ZERO, [hour(0, {}), hour(1, {})]));
  expect([merged!.value, merged!.known, merged!.peak]).toEqual(['0', true, null]);
  expect([empty!.value, empty!.caption]).toEqual(['no rate', 'No job finished in this window.']);
  expect([median!.value, median!.caption, median!.trend]).toEqual(['unknown', 'No PR merged in this window.', null]);
});

it('orders lanes by merges, then launches, then name, with an unread lane last', () => {
  const rows = laneRows([
    group('beta', { launched: 2 }), group('alpha', { launched: 2 }), group('lost', {}, NONE),
    group('top', { merged: 8, launched: 9, finished: 9, empty: 1, empty_rate: 1 / 9, median_publish_to_merge_s: 60 }), group('half', { merged: 4 }),
  ]);
  expect(rows.map(row => row.name)).toEqual(['top', 'half', 'alpha', 'beta', 'lost']);
  expect(rows.map(row => row.share)).toEqual([1, 0.5, 0, 0, null]);
  expect([rows[0]!.emptyText, rows[0]!.median]).toEqual(['1 of 9 (11%)', '1m 0s']);
  expect([rows[4]!.merged, rows[4]!.emptyText, rows[4]!.emptyRate, rows[4]!.median]).toEqual([null, 'unknown', null, 'unknown']);
});

it('draws no comparison bar when no lane merged anything', () => {
  expect(laneRows([group('a', { launched: 3 }), group('b', {})]).map(row => row.share)).toEqual([null, null]);
});
