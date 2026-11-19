/**
 * `phm fleet worklog`: the end-state numbers per hour and per day (RQ-WORKLOGN19NQ8): PRs merged, median time from
 * PR opened to merged, merged PRs per launch, launches that ended with no change, and the same by lane and by repo.
 * It buckets the marks `phm throughput` reads from the job metrics file, so one PR counts once however often its job
 * launched. `phm worklog` is the feed of single events; this is the count of them. Anything not measured is null, never zero.
 */
import { join } from 'node:path';
import { readText } from './empty-cause.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { outcomePercentile } from './outcome-metrics.js';
import { durationText, throughputMarks, type ThroughputMark } from './throughput.js';

export const WORKLOG_BY = ['hour', 'day'] as const;
export type WorklogBy = (typeof WORKLOG_BY)[number];
export const WORKLOG_MAX_HOURS = 168;

export interface WorklogCounts {
  /** `empty` is launches that ended with no change; `prs` is PRs opened. */
  launches: number | null; finished: number | null; empty: number | null; prs: number | null; merged: number | null;
  /** Median seconds from PR opened to merged; null when no merged PR has a known time. */
  median_ttm_s: number | null;
  /** Merged PRs over launches in the same period; null when nothing launched. Over 1 when earlier launches merge here. */
  merged_per_launch: number | null;
}
export interface WorklogBucket extends WorklogCounts { start: string; by_lane: Record<string, WorklogCounts>; by_repo: Record<string, WorklogCounts> }
export type WorklogNumber = 'merged' | 'median_ttm_s' | 'merged_per_launch' | 'empty' | 'launches';
/** One number, today against yesterday, with the sentence both the CLI and the desktop panel show. */
export interface WorklogCompare { number: WorklogNumber; label: string; today: number | null; yesterday: number | null; text: string }
export interface FleetWorklogReport {
  schema: 'fleet.worklog.v1'; as_of: string; hours: number; by: WorklogBy;
  /** False when the job metrics file could not be read: every count is then null. */
  known: boolean; malformed_lines: number | null;
  /** One per clock hour, oldest first; the last one is the hour in progress. */
  hourly: WorklogBucket[];
  /** Whole calendar days, oldest first; always ends with yesterday then today (in progress). */
  daily: WorklogBucket[];
  /** The `hours` window as one bucket. */
  totals: WorklogBucket;
  compare: WorklogCompare[];
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NONE: WorklogCounts = { launches: null, finished: null, empty: null, prs: null, merged: null, median_ttm_s: null, merged_per_launch: null };
const shown = (value: number | null): string => value === null ? 'unknown' : String(value);
const per100 = (rate: number | null): string => rate === null ? 'unknown' : String(Math.round(rate * 100));

function counts(marks: readonly ThroughputMark[] | null): WorklogCounts {
  if (!marks) return NONE;
  const count = (kind: ThroughputMark['kind']) => marks.filter(mark => mark.kind === kind).length;
  const launches = count('launched'), merged = count('merged');
  const median = outcomePercentile(marks.flatMap(mark => mark.kind === 'merged' && mark.seconds != null ? [mark.seconds] : []), 0.5);
  return { launches, finished: count('finished'), empty: marks.filter(mark => mark.empty).length, prs: count('published'), merged,
    median_ttm_s: median === null ? null : Math.round(median), merged_per_launch: launches ? Math.round((merged / launches) * 1000) / 1000 : null };
}

function bucket(start: number, marks: readonly ThroughputMark[] | null): WorklogBucket {
  const by = (key: 'lane' | 'repo') => Object.fromEntries([...new Set((marks ?? []).map(mark => mark.route[key]))].sort()
    .map(name => [name, counts(marks!.filter(mark => mark.route[key] === name))]));
  return { start: new Date(start).toISOString(), ...counts(marks), by_lane: by('lane'), by_repo: by('repo') };
}

/** When the file's first readable row was written. Hours wholly before it were never recorded, so they are unknown, not zero. */
function firstRowAt(ledger: string): number | null {
  for (const line of ledger.split('\n', 50)) {
    try {
      const at = Date.parse((JSON.parse(line) as { ts?: string }).ts ?? '');
      if (Number.isFinite(at)) return at;
    } catch { /* a blank or cut line */ }
  }
  return null;
}

/** Pure: validate the CLI and API options. Null when either is invalid. */
export function worklogOptions(hours?: string | null, by?: string | null): { hours: number; by: WorklogBy } | null {
  const window = hours == null ? 24 : /^\d{1,3}$/.test(hours) ? Number(hours) : NaN;
  const group = WORKLOG_BY.find(name => name === (by ?? 'hour'));
  return window >= 1 && window <= WORKLOG_MAX_HOURS && group ? { hours: window, by: group } : null;
}

/** Pure: build the report. `ledger` null means the file was unreadable. Hours and days start on the clock `utcOffsetMinutes` east of UTC (default: this machine's). */
export function buildFleetWorklog(input: { ledger: string | null; now: number; hours?: number; by?: WorklogBy; utcOffsetMinutes?: number }): FleetWorklogReport {
  const { now, ledger } = input, hours = input.hours ?? 24;
  const shift = (input.utcOffsetMinutes ?? -new Date(now).getTimezoneOffset()) * 60_000;
  const floor = (at: number, size: number) => Math.floor((at + shift) / size) * size - shift;
  const firstHour = floor(now, HOUR) - (hours - 1) * HOUR;
  const firstDay = Math.min(floor(firstHour, DAY), floor(now, DAY) - DAY);
  const read = ledger === null ? null : throughputMarks(ledger, firstDay, now, true);
  const recordedFrom = ledger === null ? null : firstRowAt(ledger);
  const between = (start: number, end: number) => !read || (recordedFrom !== null && recordedFrom >= end) ? null
    : read.marks.filter(mark => mark.at >= start && mark.at < end);
  const series = (from: number, size: number) => Array.from({ length: Math.ceil((now + 1 - from) / size) },
    (_, i) => bucket(from + i * size, between(from + i * size, from + (i + 1) * size)));
  const daily = series(firstDay, DAY), today = daily.at(-1)!, yesterday = daily.at(-2)!;
  const compare = (number: WorklogNumber, label: string, say: (value: number | null) => string, text: (today: string, yesterday: string) => string): WorklogCompare =>
    ({ number, label, today: today[number], yesterday: yesterday[number], text: text(say(today[number]), say(yesterday[number])) });
  return {
    schema: 'fleet.worklog.v1', as_of: new Date(now).toISOString(), hours, by: input.by ?? 'hour',
    known: read !== null, malformed_lines: read?.malformed ?? null,
    hourly: series(firstHour, HOUR), daily, totals: bucket(firstHour, between(firstHour, now + 1)),
    compare: [
      compare('merged', 'PRs merged', shown, (a, b) => `${a} merged today, ${b} yesterday`),
      compare('median_ttm_s', 'Time from PR opened to merged', durationText, (a, b) => `Median time from PR opened to merged: ${a} today, ${b} yesterday`),
      compare('merged_per_launch', 'Merged PRs per 100 launches', per100, (a, b) => `Merged PRs per 100 launches: ${a} today, ${b} yesterday`),
      compare('empty', 'Launches that ended with no change', shown, (a, b) => `Launches that ended with no change: ${a} today, ${b} yesterday`),
      compare('launches', 'Launches', shown, (a, b) => `${a} launches today, ${b} yesterday`),
    ],
  };
}

const line = (c: WorklogCounts): string => `${shown(c.merged)} merged, ${shown(c.launches)} launches, ${shown(c.empty)} no change, ${shown(c.prs)} PRs opened, `
  + `median ${durationText(c.median_ttm_s)}, ${per100(c.merged_per_launch)} merged per 100 launches`;

/** Pure: the plain-words view. Times are the UTC start of each hour or day. */
export function fleetWorklogText(report: FleetWorklogReport): string[] {
  if (!report.known) return ['Work log: unknown (cannot read the job metrics file).'];
  const rows = report.by === 'day' ? report.daily : report.hourly;
  const groups = (title: string, by: Record<string, WorklogCounts>) => Object.keys(by).length
    ? [`By ${title}, last ${report.hours} hours:`, ...Object.entries(by).map(([name, c]) => `  ${name}: ${line(c)}`)] : [];
  return [
    ...report.compare.map(row => `${row.text}.`),
    `By ${report.by} (UTC start):`, ...rows.map(row => `  ${row.start.slice(0, 16).replace('T', ' ')}: ${row.merged === null ? 'unknown (not recorded)' : line(row)}`),
    ...groups('lane', report.totals.by_lane), ...groups('repo', report.totals.by_repo),
    ...(report.malformed_lines ? [`Metrics lines that could not be read and were skipped: ${report.malformed_lines}.`] : []),
  ];
}

/** Read the job metrics file once. Read-only; never throws. */
export async function readFleetWorklog(opts: { hours?: number; by?: WorklogBy; now?: number; runsDir?: string } = {}): Promise<FleetWorklogReport> {
  const ledger = await readText(join(opts.runsDir ?? defaultRunsDir(), 'metrics', 'jobs.jsonl'), 32 * 1024 * 1024);
  return buildFleetWorklog({ ...opts, ledger, now: opts.now ?? Date.now() });
}
