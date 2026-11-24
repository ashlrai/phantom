/** A `phm throughput --by model` report with plainly made-up counts, for the Models board's work tests. */
import type { ThroughputCounts, ThroughputGroup, ThroughputReport } from '../../../../core/fleet/throughput.js';

export const WORK_NOW = Date.parse('2026-11-18T12:00:00Z');
const HOUR = 3_600_000;

export const workCounts = (over: Partial<ThroughputCounts> = {}): ThroughputCounts =>
  ({ launched: 0, published: 0, merged: 0, finished: 0, empty: 0, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: 0, ...over });

/** `at` maps an hour's place in the window (0 is the oldest) to what happened in it. */
const hoursOf = (hours: number, at: Readonly<Record<number, Partial<ThroughputCounts>>>) =>
  Array.from({ length: hours }, (_, i) => ({ start: new Date(WORK_NOW - (hours - i) * HOUR).toISOString(), ...workCounts(at[i]) }));

export const workGroup = (name: string, totals: Partial<ThroughputCounts>, at: Readonly<Record<number, Partial<ThroughputCounts>>> = {}, hours = 24): ThroughputGroup =>
  ({ name, totals: workCounts(totals), buckets: hoursOf(hours, at) });

export function workReport(groups: ThroughputGroup[], over: Partial<ThroughputReport> = {}): ThroughputReport {
  const hours = over.hours ?? 24;
  const sum = (key: 'launched' | 'merged' | 'finished' | 'empty') => groups.reduce((total, group) => total + (group.totals[key] ?? 0), 0);
  return {
    schema: 'throughput.v1', as_of: new Date(WORK_NOW).toISOString(), since: new Date(WORK_NOW - hours * HOUR).toISOString(), hours, by: 'model',
    metrics_path: '/fake/metrics/jobs.jsonl', metrics: 'ok', malformed_lines: 0, main: 'unknown', headline: 'fixture',
    totals: workCounts({ launched: sum('launched'), merged: sum('merged'), finished: sum('finished'), empty: sum('empty') }),
    buckets: hoursOf(hours, {}), groups, ...over,
  };
}
