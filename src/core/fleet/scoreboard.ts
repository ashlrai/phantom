/**
 * `phm fleet score`: one scoreboard for what the fleet optimizes (RQ-SCOREBOARDN19UQ8).
 *
 * Pure over the job metrics file, reading the same launch, finish, publish and merged-outcome rows
 * as `phm fleet launches` and `phm fleet ttm` (it reuses `ledgerRows`). It returns, per hour for the
 * last 24 hours and per day for the last N days: merged PRs, median seconds from publish to merge,
 * starts, empty finishes, merged per start, empty share and self-improvement share, plus a trend
 * for each (this window against the one before it). A number with nothing behind it is null, never
 * zero; a bucket that saw no job events at all is entirely null. Spend-down is not recomputed here:
 * the desktop view shows the existing spend-down card beside these numbers.
 */
import { ledgerRows, readText } from './empty-cause.js';

export const SCOREBOARD_SCHEMA = 'fleet.scoreboard.v1';
export const SCOREBOARD_MAX_DAYS = 30;
/** The repo whose merged PRs count as the fleet improving itself. */
export const SELF_REPO = 'phantom';
/** A change under this share of the earlier value reads as flat. */
export const FLAT_BAND = 0.05;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEDGER_TAIL_BYTES = 32 * 1024 * 1024;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;
const REPO = /^[\w][\w.-]{0,79}(\/[\w][\w.-]{0,79})?$/;

export type Trend = 'up' | 'down' | 'flat' | 'unknown';
export const SCORE_KEYS = ['merged', 'median_ttm_s', 'starts', 'empty_finishes', 'merged_per_start', 'empty_share', 'self_improvement_share'] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

/** One bucket, or one whole window. Every number is null when there is nothing behind it. */
export interface ScorePoint {
  start: string;
  end: string;
  merged: number | null;
  /** Median of the merged PRs that recorded a time to merge; null when none did. */
  median_ttm_s: number | null;
  starts: number | null;
  /** Jobs that finished, the base of the empty share. */
  finishes: number | null;
  empty_finishes: number | null;
  merged_per_start: number | null;
  /** Empty finishes over finishes. */
  empty_share: number | null;
  /** Merged PRs in the phantom repo over all merged PRs. */
  self_improvement_share: number | null;
}

export interface ScoreSeries {
  span: 'hour' | 'day';
  points: ScorePoint[];
  /** The whole window, computed from events (not averaged from points). */
  current: ScorePoint;
  /** The window of the same length just before it. */
  previous: ScorePoint;
  trend: Record<ScoreKey, Trend>;
}

export interface Scoreboard {
  schema: typeof SCOREBOARD_SCHEMA;
  as_of: string;
  days: number;
  metrics: 'ok' | 'unreadable';
  hourly: ScoreSeries;
  daily: ScoreSeries;
}

interface Merge { at: number; repo: string | null; ttm: number | null }
interface Events { activity: number[]; starts: number[]; finishes: { at: number; empty: boolean }[]; merges: Merge[] }

const text = (value: unknown): string | null => typeof value === 'string' && REPO.test(value.trim()) ? value.trim() : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Pure: validate `--days` / `?days=` (whole days, 1 to 30, default 7). Null when invalid. */
export function scoreboardDays(value?: string | null): number | null {
  const days = value == null ? 7 : /^\d{1,2}$/.test(value) ? Number(value) : NaN;
  return days >= 1 && days <= SCOREBOARD_MAX_DAYS ? days : null;
}

/** Pure: sort ledger rows into starts, finishes and merges. Re-emitted rows count once. */
function readEvents(ledger: string, now: number, lookbackHours: number): Events {
  const { rows } = ledgerRows(ledger, now, lookbackHours, true);
  const events: Events = { activity: [], starts: [], finishes: [], merges: [] };
  const repoOfJob = new Map<string, string>();
  const startKeys = new Set<string>();
  const finishes = new Map<string, { at: number; empty: boolean }>();
  const merges = new Map<string, Merge & { job: string }>();
  for (const { row, id, at } of rows) {
    const event = row.event ?? (row.source === 'metrics-outcomes-reconciler' ? 'outcome' : null);
    const url = PR_URL.exec(String(row.url ?? row.prUrl ?? row.pr_url ?? row.pr ?? ''));
    const repo = url ? url[1]!.toLowerCase() : text(row.repo)?.toLowerCase() ?? null;
    if (id && repo && (event === 'launch' || event === 'publish' || event === 'published' || !repoOfJob.has(id))) repoOfJob.set(id, repo);
    const state = row.state ?? row.outcome ?? row.status;
    if (event === 'launch' && id) {
      if (!startKeys.has(`${id}@${at}`)) { startKeys.add(`${id}@${at}`); events.starts.push(at); events.activity.push(at); }
    } else if (event === 'publish' || event === 'published') {
      events.activity.push(at);
    } else if (id && (event === 'finish' || state === 'EMPTY_DONE' || (event === 'outcome' && row.empty === true))) {
      const empty = row.empty === true || state === 'EMPTY_DONE';
      const seen = finishes.get(id);
      // One finish per job: the earliest time, empty when any row for it says so.
      finishes.set(id, { at: seen ? Math.min(seen.at, at) : at, empty: empty || (seen?.empty ?? false) });
      events.activity.push(at);
    }
    const merged = event === 'merged' || (event === 'outcome' && state === 'MERGED');
    const key = url ? `${url[1]}#${url[2]}`.toLowerCase() : id ? `job:${id}` : null;
    if (!merged || key === null) continue;
    const stamp = typeof row.mergedAt === 'string' ? Date.parse(row.mergedAt) : NaN;
    const when = Number.isFinite(stamp) && stamp <= now ? stamp : at;
    const seen = merges.get(key);
    if (!seen) merges.set(key, { job: id, at: when, repo, ttm: num(row.ttm_s) });
    else merges.set(key, { job: seen.job || id, at: Math.min(seen.at, when), repo: seen.repo ?? repo, ttm: seen.ttm ?? num(row.ttm_s) });
  }
  events.finishes = [...finishes.values()];
  for (const merge of merges.values()) {
    events.merges.push({ at: merge.at, repo: merge.repo ?? repoOfJob.get(merge.job) ?? null, ttm: merge.ttm });
    events.activity.push(merge.at);
  }
  return events;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const ratio = (top: number, bottom: number): number | null => bottom > 0 ? top / bottom : null;

/** Every number for [from, to). A window with no job events at all is all null. */
function scorePoint(events: Events, from: number, to: number): ScorePoint {
  const within = (at: number) => at >= from && at < to;
  const base = { start: new Date(from).toISOString(), end: new Date(to).toISOString() };
  if (!events.activity.some(within)) {
    return { ...base, merged: null, median_ttm_s: null, starts: null, finishes: null, empty_finishes: null, merged_per_start: null, empty_share: null, self_improvement_share: null };
  }
  const merges = events.merges.filter(merge => within(merge.at));
  const starts = events.starts.filter(within).length;
  const finishes = events.finishes.filter(finish => within(finish.at));
  const empty = finishes.filter(finish => finish.empty).length;
  const own = merges.filter(merge => merge.repo !== null && (merge.repo.split('/').pop() === SELF_REPO)).length;
  return {
    ...base, merged: merges.length,
    median_ttm_s: median(merges.flatMap(merge => merge.ttm === null ? [] : [merge.ttm])),
    starts, finishes: finishes.length, empty_finishes: empty,
    merged_per_start: ratio(merges.length, starts),
    empty_share: ratio(empty, finishes.length),
    self_improvement_share: ratio(own, merges.length),
  };
}

/** Pure: this window against the one before it. Unknown when either side has no number. */
export function trendOf(current: number | null, previous: number | null): Trend {
  if (current === null || previous === null) return 'unknown';
  if (previous === 0) return current === 0 ? 'flat' : 'up';
  const change = (current - previous) / previous;
  return Math.abs(change) < FLAT_BAND ? 'flat' : change > 0 ? 'up' : 'down';
}

function series(events: Events, span: 'hour' | 'day', count: number, now: number): ScoreSeries {
  const size = span === 'hour' ? HOUR : DAY, window = count * size, since = now - window;
  const points = Array.from({ length: count }, (_, i) => scorePoint(events, since + i * size, since + (i + 1) * size));
  const current = scorePoint(events, since, now + 1), previous = scorePoint(events, since - window, since);
  const trend = Object.fromEntries(SCORE_KEYS.map(key => [key, trendOf(current[key], previous[key])])) as Record<ScoreKey, Trend>;
  return { span, points, current, previous, trend };
}

/** Pure: the scoreboard. `ledger` null means the job metrics file could not be read. */
export function buildScoreboard(input: { ledger: string | null; now: number; days: number }): Scoreboard {
  const { now, days } = input;
  const events = readEvents(input.ledger ?? '', now, Math.max(2 * days, 2) * 24);
  return {
    schema: SCOREBOARD_SCHEMA, as_of: new Date(now).toISOString(), days, metrics: input.ledger === null ? 'unreadable' : 'ok',
    hourly: series(events, 'hour', 24, now), daily: series(events, 'day', days, now),
  };
}

/** Read the job metrics file and build the scoreboard. Read-only; never throws. */
export async function readScoreboard(opts: { metricsPath: string; days: number; now: number }): Promise<Scoreboard> {
  return buildScoreboard({ ledger: await readText(opts.metricsPath, LEDGER_TAIL_BYTES), now: opts.now, days: opts.days });
}

const ARROW: Record<Trend, string> = { up: 'up', down: 'down', flat: 'flat', unknown: 'unknown' };
const shown = (value: number | null, unit = ''): string => value === null ? 'unknown' : `${Math.round(value * 100) / 100}${unit}`;
const percent = (value: number | null): string => value === null ? 'unknown' : `${Math.round(value * 100)}%`;

/** Plain lines for the CLI: one per number, this window with its trend. */
export function scoreboardText(board: Scoreboard): string[] {
  if (board.metrics === 'unreadable') return ['Scoreboard: unknown (cannot read the job metrics file).'];
  const lines = (name: string, s: ScoreSeries, per: string) => [
    `${name} (trend against the ${per} before)`,
    `  merged PRs: ${shown(s.current.merged)} (${ARROW[s.trend.merged]})`,
    `  median time to merge: ${shown(s.current.median_ttm_s, ' s')} (${ARROW[s.trend.median_ttm_s]})`,
    `  starts: ${shown(s.current.starts)} (${ARROW[s.trend.starts]})`,
    `  empty finishes: ${shown(s.current.empty_finishes)} (${ARROW[s.trend.empty_finishes]}), empty share ${percent(s.current.empty_share)} (${ARROW[s.trend.empty_share]})`,
    `  merged per start: ${shown(s.current.merged_per_start)} (${ARROW[s.trend.merged_per_start]})`,
    `  self-improvement share: ${percent(s.current.self_improvement_share)} (${ARROW[s.trend.self_improvement_share]})`,
  ];
  return [...lines('Last 24 hours', board.hourly, '24 hours'), ...lines(`Last ${board.days} days`, board.daily, `${board.days} days`)];
}
