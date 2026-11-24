import { expect, it } from 'vitest';
import type { ThroughputCounts, ThroughputHour, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { columnWhen } from '../models/model-work-model.js';
import { figures } from './throughput-board-model.js';
import { barUnit, barWords, busiestWords, cursorBars, heldFigures, laneBarWords, mostLaunched } from './throughput-cursor-model.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const START = Date.UTC(2026, 10, 17, 6);
const hoursOf = (count: number, at: Readonly<Record<number, Partial<ThroughputCounts>>> = {}, rest: ThroughputCounts = ZERO): ThroughputHour[] =>
  Array.from({ length: count }, (_, i) => ({ start: new Date(START + i * 3_600_000).toISOString(), ...rest, ...at[i] }));
const report = (buckets: ThroughputHour[], totals: ThroughputCounts): ThroughputReport => ({
  schema: 'throughput.v1', as_of: '', since: '', hours: buckets.length, by: 'lane', metrics_path: '', metrics: 'ok', malformed_lines: 0, main: 'unknown', headline: '', totals, buckets, groups: [],
});

it('draws a bar an hour for a day and keeps each hour its own counts, rate and median', () => {
  const bars = cursorBars(hoursOf(24, { 3: { launched: 4, published: 3, merged: 2, finished: 4, empty: 1, empty_rate: 0.25, median_publish_to_merge_s: 120 } }));
  expect(bars).toHaveLength(24);
  expect(bars[3]).toEqual({
    start: new Date(START + 3 * 3_600_000).toISOString(), hours: 1, launched: 4, merged: 2, read: true,
    counts: { launched: 4, published: 3, merged: 2, finished: 4, empty: 1 }, emptyRate: 0.25, median: 120,
  });
  expect([barUnit(bars[3]!), mostLaunched([bars]), mostLaunched([])]).toEqual(['hour', 4, 0]);
});

it('folds 7 days into 24 bars of 7 hours, adding the counts and keeping no median', () => {
  const bars = cursorBars(hoursOf(168, {
    7: { launched: 2, finished: 2, empty: 1, empty_rate: 0.5, median_publish_to_merge_s: 60 },
    9: { launched: 3, merged: 1, finished: 2, empty: 0, empty_rate: 0, median_publish_to_merge_s: 90 },
  }));
  expect(bars).toHaveLength(24);
  expect([bars[1]!.hours, bars[1]!.start, barUnit(bars[1]!)]).toEqual([7, new Date(START + 7 * 3_600_000).toISOString(), '7 hours']);
  expect(bars[1]!.counts).toEqual({ launched: 5, published: 0, merged: 1, finished: 4, empty: 1 });
  expect([bars[1]!.emptyRate, bars[1]!.median]).toEqual([0.25, null]);
  // No job finished in the bar: no rate, never 0%.
  expect(bars[0]!.emptyRate).toBeNull();
});

it('keeps a count one of the hours does not hold as unknown, and hatches the bar', () => {
  const bars = cursorBars(hoursOf(14, { 8: NONE, 9: { launched: 2 } }), 2);
  expect([bars[0]!.read, bars[0]!.counts.launched]).toEqual([true, 0]);
  expect([bars[1]!.read, bars[1]!.launched, bars[1]!.counts.launched, bars[1]!.counts.merged]).toEqual([false, 0, null, null]);
  expect(barWords(bars[1]!)).toBe(`${columnWhen(bars[1]!)}: jobs launched unknown, PRs published unknown, PRs merged unknown.`);
  expect(laneBarWords(bars[1]!)).toBe(`${columnWhen(bars[1]!)}: launched unknown, published unknown, merged unknown`);
  expect(busiestWords(bars)).toBe('Launches unknown for part of this window');
});

it('says one bar in words, and names the busiest bar while none is held', () => {
  const bars = cursorBars(hoursOf(6, {
    1: { launched: 5 }, 2: { launched: 1, published: 1, merged: 1, finished: 3, empty: 2, empty_rate: 2 / 3 }, 4: { launched: 5, published: 2 },
  }));
  expect(barWords(bars[2]!)).toBe(`${columnWhen(bars[2]!)}: 1 job launched, 1 PR published, 1 PR merged, 2 of 3 finished jobs changed nothing.`);
  expect(barWords(bars[4]!)).toBe(`${columnWhen(bars[4]!)}: 5 jobs launched, 2 PRs published, 0 PRs merged, no job finished.`);
  expect(laneBarWords(bars[4]!)).toBe(`${columnWhen(bars[4]!)}: launched 5, published 2, merged 0`);
  // The later of two equal bars.
  expect(busiestWords(bars)).toBe(`Busiest: ${columnWhen(bars[4]!)}, 5 launched`);
  expect(busiestWords(cursorBars(hoursOf(6)))).toBe('No job launched in this window');
});

it('turns the figure tiles into the held hour, with a quiet hour worded as measured', () => {
  const buckets = hoursOf(6, { 2: { launched: 4, published: 3, merged: 2, finished: 4, empty: 1, empty_rate: 0.25, median_publish_to_merge_s: 120 }, 5: { launched: 6, merged: 1 } });
  const base = figures(report(buckets, { ...ZERO, launched: 10, published: 3, merged: 3, finished: 4, empty: 1, empty_rate: 0.25, median_publish_to_merge_s: 120 }));
  const bars = cursorBars(buckets);
  const tile = (index: number) => heldFigures(base, bars[index]!).map(figure => [figure.id, figure.value, figure.known, figure.caption, figure.held, figure.peak]);
  expect(tile(2)).toEqual([
    ['launched', '4', true, 'In this hour', true, null], ['published', '3', true, 'In this hour', true, null], ['merged', '2', true, 'In this hour', true, null],
    ['empty', '25%', true, '1 of 4 finished jobs, in this hour', true, null], ['median', '2m 0s', true, 'From publish to merge, in this hour', true, null],
  ]);
  expect(tile(0).slice(3)).toEqual([['empty', 'no rate', false, 'No job finished in this hour.', true, null], ['median', 'unknown', false, 'No PR merged in this hour.', true, null]]);
  // A PR merged with no publish time recorded: the hour has merges and no median.
  expect(tile(5)[4]).toEqual(['median', 'unknown', false, 'No timed merge in this hour.', true, null]);
  // The trend line under each figure stays the window's.
  expect(heldFigures(base, bars[2]!).map(figure => figure.trend)).toEqual(base.map(figure => figure.trend));
});

it('leaves the median the window’s on a folded bar and says why', () => {
  const buckets = hoursOf(168, { 0: { launched: 2, merged: 1, median_publish_to_merge_s: 60 } });
  const base = figures(report(buckets, { ...ZERO, launched: 2, merged: 1, median_publish_to_merge_s: 60 }));
  const held = heldFigures(base, cursorBars(buckets)[0]!);
  expect([held[4]!.value, held[4]!.caption, held[4]!.held]).toEqual(['1m 0s', 'Whole window: no median is kept for a 7 hour bar', undefined]);
  expect([held[0]!.value, held[0]!.caption]).toEqual(['2', 'In these 7 hours']);
});
