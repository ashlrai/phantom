/**
 * Scoreboard trends (RQ-TRENDSN19YQ8): how the scoreboard's numbers moved over the last 24 hours
 * (24 one-hour buckets) or 7 days (28 six-hour buckets), one series per metric and one per usage pool.
 *
 * Pure over job records and usage readings. A bucket with nothing behind it is null: never zero and
 * never carried forward from the bucket before. A bucket that saw no job events at all is null for
 * every job metric; a bucket with starts and no merges is a real zero. Jobs are counted where the
 * thing happened: starts, the merge share and the empty share by the start time (so a job that spans
 * a bucket edge counts once, in the bucket it started in), merges and the publish-to-merge time by
 * the merge time. A used percent that drops marks a reset in that bucket.
 */
/* Browser-safe: no node imports, the Trends view imports this file. The ledger reader is in scoreboard.ts. */
export const TREND_SCHEMA = 'fleet.scoreboard-trend.v1';
const HOUR = 3_600_000;

export type TrendWindow = '24h' | '7d';
export const TREND_WINDOWS: Record<TrendWindow, { hours: number; bucketHours: number; since: string }> = {
  '24h': { hours: 24, bucketHours: 1, since: 'yesterday' },
  '7d': { hours: 7 * 24, bucketHours: 6, since: 'a week ago' },
};
/** Pure: `--trend` / `?trend=` value. Null when it is not one of the two windows. */
export const trendWindow = (value: string | null | undefined): TrendWindow | null =>
  value === '24h' || value === '7d' ? value : null;

/** One job. Times are ISO strings; null is unknown. */
export interface TrendJob {
  job: string;
  lane: string | null;
  tier: string | null;
  started: string | null;
  finished: string | null;
  empty: boolean | null;
  merged: boolean;
  published_at: string | null;
  merged_at: string | null;
}
/** One usage reading (the same fields as a `fleet.usage-history.v1` row). */
export interface TrendReading { pool: string; used_pct: number; observed_at: string }

export type TrendUnit = 'count' | 'share' | 'minutes' | 'percent';
export interface TrendChange {
  from: number | null;
  to: number | null;
  /** latest minus start; null when there is nothing to compare. */
  delta: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  /** Plain words, e.g. "up 12 from yesterday". */
  words: string;
}
export interface TrendSeries {
  key: string;
  label: string;
  unit: TrendUnit;
  /** Which way is good; null when neither (spend is not good or bad). */
  better: 'up' | 'down' | null;
  /** One value per bucket, null for no data. Shares are fractions. */
  values: (number | null)[];
  /** Bucket numbers where a pool's used percent dropped (its window reset). */
  resets: number[];
  latest: number | null;
  change: TrendChange;
  /** For a screen reader: what the chart shows, in one sentence. */
  summary: string;
}
export interface TrendReport {
  schema: typeof TREND_SCHEMA;
  window: TrendWindow;
  bucket_hours: number;
  from: string;
  to: string;
  bucket_starts: string[];
  metrics: TrendSeries[];
  pools: TrendSeries[];
  /** One plain sentence: what improved most and what worsened most. */
  sentence: string;
}

const ms = (iso: string | null): number => iso === null ? NaN : Date.parse(iso);
const known = (v: number | null): v is number => v !== null;
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

/** Display of one value in its unit. */
export function trendValue(value: number | null, unit: TrendUnit): string {
  if (value === null) return 'unknown';
  if (unit === 'share' || unit === 'percent') return `${round(unit === 'share' ? value * 100 : value, 1)}%`;
  return unit === 'minutes' ? `${round(value, 1)} min` : String(round(value, 1));
}

function changeOf(values: (number | null)[], from: number, unit: TrendUnit, since: string): TrendChange {
  const seen = values.slice(from).filter(known);
  if (seen.length < 2) return { from: seen[0] ?? null, to: seen[0] ?? null, delta: null, direction: null, words: 'nothing earlier to compare with' };
  const start = seen[0]!, end = seen.at(-1)!;
  const scale = unit === 'share' ? 100 : 1;
  const delta = round((end - start) * scale, 1);
  if (delta === 0) return { from: start, to: end, delta: 0, direction: 'flat', words: `no change from ${since}` };
  const amount = unit === 'minutes' ? `${Math.abs(delta)} min` : unit === 'count' ? `${Math.abs(delta)}` : `${Math.abs(delta)} points`;
  const direction = delta > 0 ? 'up' : 'down';
  return { from: start, to: end, delta, direction, words: `${direction} ${amount} from ${since}` };
}

function describe(label: string, values: (number | null)[], unit: TrendUnit, latest: number | null, change: TrendChange, resets: number[], starts: string[]): string {
  const have = values.filter(known).length;
  if (have === 0) return `${label}: no data in this window.`;
  const gaps = values.length - have;
  const parts = [`${label}: latest ${trendValue(latest, unit)}, ${change.words}`, `${have} of ${values.length} periods have data${gaps ? `, ${gaps} without` : ''}`];
  if (resets.length) parts.push(`reset at ${resets.map(i => starts[i]!.slice(11, 16)).join(', ')}`);
  return `${parts.join('; ')}.`;
}

function finish(key: string, label: string, unit: TrendUnit, better: 'up' | 'down' | null, values: (number | null)[], resets: number[], report: { since: string; starts: string[] }): TrendSeries {
  // After a reset the earlier numbers are a different window, so compare from the reset on.
  const from = resets.length ? resets.at(-1)! : 0;
  const latest = values.filter(known).at(-1) ?? null;
  const change = changeOf(values, from, unit, report.since);
  return { key, label, unit, better, values, resets, latest, change, summary: describe(label, values, unit, latest, change, resets, report.starts) };
}

/** Pure: the trend report. `jobs` and `usage` may hold anything; only the window's buckets are read. */
export function buildTrend(input: { jobs: readonly TrendJob[]; usage: readonly TrendReading[]; window: TrendWindow; now: number }): TrendReport {
  const { hours, bucketHours, since } = TREND_WINDOWS[input.window];
  const size = bucketHours * HOUR, count = hours / bucketHours;
  const from = input.now - hours * HOUR;
  const bucket = (t: number): number => Number.isFinite(t) && t >= from && t <= input.now ? Math.min(count - 1, Math.floor((t - from) / size)) : -1;
  const starts = Array.from({ length: count }, (_, i) => new Date(from + i * size).toISOString());

  const active = new Array<boolean>(count).fill(false);
  const started = Array.from({ length: count }, () => 0), cohortMerged = [...started], finished = [...started], empty = [...started];
  const merged = [...started], minutes: number[][] = Array.from({ length: count }, () => []);
  for (const job of input.jobs) {
    const s = bucket(ms(job.started)), f = bucket(ms(job.finished)), p = bucket(ms(job.published_at)), m = bucket(ms(job.merged_at));
    for (const i of [s, f, p, m]) if (i >= 0) active[i] = true;
    if (s >= 0) {
      started[s]!++;
      if (job.merged) cohortMerged[s]!++;
      if (Number.isFinite(ms(job.finished))) { finished[s]!++; if (job.empty) empty[s]!++; }
    }
    if (m >= 0 && job.merged) {
      merged[m]!++;
      const minutesToMerge = (ms(job.merged_at) - ms(job.published_at)) / 60_000;
      if (Number.isFinite(minutesToMerge) && minutesToMerge >= 0) minutes[m]!.push(minutesToMerge);
    }
  }
  const per = (value: (i: number) => number | null): (number | null)[] => active.map((on, i) => on ? value(i) : null);
  const ctx = { since, starts };
  const metrics = [
    finish('merged', 'PRs merged', 'count', 'up', per(i => merged[i]!), [], ctx),
    finish('starts', 'Jobs started', 'count', 'up', per(i => started[i]!), [], ctx),
    finish('merge_share', 'Starts that merged', 'share', 'up', per(i => started[i]! > 0 ? cohortMerged[i]! / started[i]! : null), [], ctx),
    finish('empty_share', 'Starts that ended empty', 'share', 'down', per(i => finished[i]! > 0 ? empty[i]! / finished[i]! : null), [], ctx),
    finish('median_minutes_to_merge', 'Minutes from publish to merge', 'minutes', 'down', per(i => median(minutes[i]!)), [], ctx),
  ];

  // Per pool: the last reading in each bucket (never carried to a bucket with none); a drop from the
  // reading before it, even one from before the window, is a reset in the bucket it landed in.
  const byPool = new Map<string, TrendReading[]>();
  for (const reading of input.usage) {
    if (!Number.isFinite(reading.used_pct) || !Number.isFinite(ms(reading.observed_at)) || ms(reading.observed_at) > input.now) continue;
    byPool.set(reading.pool, [...(byPool.get(reading.pool) ?? []), reading]);
  }
  const pools = [...byPool.keys()].sort().map(pool => {
    const rows = byPool.get(pool)!.sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
    const values = new Array<number | null>(count).fill(null), resets: number[] = [];
    rows.forEach((row, n) => {
      const i = bucket(ms(row.observed_at));
      if (i < 0) return;
      values[i] = row.used_pct;
      if (n > 0 && row.used_pct < rows[n - 1]!.used_pct && !resets.includes(i)) resets.push(i);
    });
    return finish(`pool:${pool}`, `${pool} used`, 'percent', null, values, resets, ctx);
  });

  return { schema: TREND_SCHEMA, window: input.window, bucket_hours: bucketHours, from: starts[0]!, to: new Date(input.now).toISOString(),
    bucket_starts: starts, metrics, pools, sentence: trendSentence(metrics) };
}

/** Pure: one sentence naming the metric that improved most and the one that worsened most (by relative change). */
export function trendSentence(metrics: readonly TrendSeries[]): string {
  const moves = metrics.flatMap(m => {
    const { from, to, direction } = m.change;
    if (m.better === null || (direction !== 'up' && direction !== 'down') || from === null || to === null) return [];
    const size = Math.abs(to - from) / Math.max(Math.abs(from), Math.abs(to));
    return [{ m, gain: (direction === m.better ? 1 : -1) * size }];
  });
  const best = moves.filter(x => x.gain > 0).sort((a, b) => b.gain - a.gain)[0];
  const worst = moves.filter(x => x.gain < 0).sort((a, b) => a.gain - b.gain)[0];
  const say = (x: { m: TrendSeries }) => `${x.m.label.toLowerCase()} (${x.m.change.words})`;
  if (best && worst) return `${cap(say(best))} improved most and ${say(worst)} worsened most.`;
  if (best) return `${cap(say(best))} improved most; nothing got worse.`;
  if (worst) return `${cap(say(worst))} worsened most; nothing improved.`;
  return 'Nothing has clearly moved yet, or there is not enough data to say.';
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const SPARK = '▁▂▃▄▅▆▇█';
/** Plain-text chart: one glyph per bucket, a dot for no data, ↺ at a reset. */
export function sparkText(series: TrendSeries): string {
  const seen = series.values.filter(known), lo = Math.min(...seen), hi = Math.max(...seen);
  return series.values.map((v, i) => v === null ? '·' : series.resets.includes(i) ? '↺' : SPARK[hi === lo ? 3 : Math.round((v - lo) / (hi - lo) * 7)]!).join('');
}

/** Plain lines for the CLI: the sentence first, then one line per metric and pool. */
export function trendText(report: TrendReport): string[] {
  const span = report.window === '24h' ? 'Last 24 hours, by hour' : 'Last 7 days, by 6 hours';
  return [report.sentence, '', `Trends: ${span} (· is no data, ↺ is a reset)`,
    ...[...report.metrics, ...report.pools].map(s => `  ${s.label}: ${trendValue(s.latest, s.unit)} (${s.change.words}) ${sparkText(s)}`)];
}
