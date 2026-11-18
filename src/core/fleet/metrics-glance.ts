/**
 * `phm metrics`: how well the self-improving loop is running, in one glance (RQ-METRICSN18HQ8).
 *
 * It adds no parser of its own. Merge pace, merge time and empty rate come from
 * the `phm throughput` report over `metrics/jobs.jsonl`; spend-down comes from
 * the `phm usage` spend projection over the dispatcher status file; lanes and
 * tiers are the dispatcher's own 24-hour rollup (`rollup_24h`), the numbers it
 * steers by. The desktop Metrics view shows this exact report.
 * Anything missing or stale is null (JSON) or "unknown" (text), never zero.
 */
import { join } from 'node:path';
import { projectUsageSpend } from '../usage/spend.js';
import { readText } from './empty-cause.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { buildThroughput, durationText, type ThroughputReport } from './throughput.js';

export interface MetricsLane {
  name: string;
  /** Jobs launched in the last 24 hours. */
  jobs: number | null; merged: number | null;
  /** Shares of finished jobs, 0..1. */
  empty_rate: number | null; merge_rate: number | null;
  /** More than half of the finished jobs changed nothing. */
  empty_high: boolean | null;
}
export interface MetricsPool {
  pool: string;
  used_pct: number | null; hours_to_reset: number | null; projected_unused_pct: number | null;
  /** The dispatcher's own label (low, medium, high) when it gives one. */
  waste_risk: string | null;
  /** A measured share would go unused at reset, or the dispatcher says medium or high. */
  at_risk: boolean | null;
  /** Why the reading is unknown; null when it is complete. */
  reason: string | null;
}
export interface MetricsReport {
  schema: 'metrics.glance.v1'; version: 1;
  as_of: string;
  /** Window for `merged`, `median_publish_to_merge_s` and `empty_rate`. */
  hours: number;
  sources: { jobs: 'ok' | 'unreadable'; status: 'ok' | 'stale' | 'missing'; status_as_of: string | null };
  headline: string;
  /** PRs merged per hour, averaged over each period. */
  merged_per_hour: { last_1h: number | null; last_6h: number | null; last_24h: number | null; window: number | null };
  merged: number | null;
  median_publish_to_merge_s: number | null;
  empty_rate: number | null;
  /** Null when no pool has a usable reading. */
  pools_at_risk: number | null;
  /** Dispatcher rollup of jobs launched in the last 24 hours; null when the status file is missing or stale. */
  lanes: MetricsLane[] | null;
  tiers: MetricsLane[] | null;
  pools: MetricsPool[];
}
/** Injectable sources: the parsed dispatcher status (null when unreadable) and the raw jobs file (null when unreadable). */
export interface MetricsReader { status(): Promise<unknown>; jobs(): Promise<string | null> }

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const share = (v: unknown): number | null => typeof v === 'number' && v >= 0 && v <= 1 ? v : null;
const shown = (value: number | string | null): string => value === null ? 'unknown' : String(value);
/** "18%"; null is "unknown". */
export const percent = (value: number | null): string => value === null ? 'unknown' : `${Math.round(value * 100)}%`;
const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

function rollupRows(raw: unknown): MetricsLane[] | null {
  if (!object(raw)) return null;
  return Object.entries(raw).filter(([, row]) => object(row)).map(([key, value]) => {
    const row = value as Record<string, unknown>;
    const empty = share(row.empty_rate);
    // A job with no lane or tier is recorded under the key "null".
    return { name: /^[\w][\w.:@/-]{0,79}$/.test(key) && key !== 'null' ? key : 'unknown', jobs: count(row.jobs), merged: count(row.merged),
      empty_rate: empty, merge_rate: share(row.merge_rate), empty_high: empty === null ? null : empty > 0.5 };
  }).sort((a, b) => (b.jobs ?? -1) - (a.jobs ?? -1) || a.name.localeCompare(b.name));
}

/** Pure: build the report from the two sources. `ledger` null means the jobs file was unreadable. */
export function buildMetrics(input: { status: unknown; ledger: string | null; now: number; hours: number }): MetricsReport {
  const { now, hours } = input;
  const status = object(input.status) ? input.status : null;
  const tick = typeof status?.last_tick === 'string' ? Date.parse(status.last_tick) : NaN;
  // Same freshness rule as the spend projection: a dispatcher tick in the last two minutes.
  const fresh = status?.schema === 'dispatchd.status.v1' && Number.isFinite(tick) && now >= tick && now - tick <= 120_000;
  const throughput = (span: number): ThroughputReport => buildThroughput({ ledger: input.ledger, now, hours: span, by: 'tier', metricsPath: '' });
  const day = throughput(Math.max(24, hours));
  const window = hours === day.hours ? day : throughput(hours);
  const pace = (span: number): number | null => day.metrics !== 'ok' ? null
    : round(day.buckets.slice(-span).reduce((sum, hour) => sum + (hour.merged ?? 0), 0) / span);
  const budget = object(status?.budget) ? status.budget : {};
  const pools = projectUsageSpend(input.status, now).pools.map((row): MetricsPool => {
    const lane = budget[row.pool]; const raw = object(lane) && object(lane.use_it_all) ? lane.use_it_all.waste_risk : null;
    const known = row.verdict !== 'unknown' && row.verdict !== 'expired';
    const label = known && typeof raw === 'string' && /^[a-z]{1,12}$/.test(raw) ? raw : null;
    return { pool: row.pool, used_pct: row.usedPercent === null ? null : round(row.usedPercent, 1),
      hours_to_reset: row.hoursLeft === null ? null : round(row.hoursLeft, 1),
      projected_unused_pct: row.projectedUnusedPercent === null ? null : round(row.projectedUnusedPercent, 1),
      waste_risk: label, at_risk: known ? row.verdict === 'behind' || label === 'medium' || label === 'high' : null,
      reason: row.reason ?? (row.verdict === 'expired' ? 'expired' : null) };
  });
  const measured = pools.filter(pool => pool.at_risk !== null);
  const rollup = fresh && object(status.rollup_24h) ? status.rollup_24h : {};
  const totals = window.totals;
  const report: Omit<MetricsReport, 'headline'> = {
    schema: 'metrics.glance.v1', version: 1, as_of: new Date(now).toISOString(), hours,
    sources: { jobs: day.metrics, status: fresh ? 'ok' : status ? 'stale' : 'missing', status_as_of: Number.isFinite(tick) ? new Date(tick).toISOString() : null },
    merged_per_hour: { last_1h: pace(1), last_6h: pace(6), last_24h: pace(24), window: totals.merged === null ? null : round(totals.merged / hours) },
    merged: totals.merged, median_publish_to_merge_s: totals.median_publish_to_merge_s, empty_rate: totals.empty_rate,
    pools_at_risk: measured.length ? measured.filter(pool => pool.at_risk).length : null,
    lanes: rollupRows(rollup.by_lane), tiers: rollupRows(rollup.by_tier), pools,
  };
  return { ...report, headline: `merged per hour ${shown(report.merged_per_hour.window)}, median merge ${durationText(report.median_publish_to_merge_s)}, empty ${
    percent(report.empty_rate)}, pools at risk ${shown(report.pools_at_risk)}` };
}

/** Plain words for one pool's spend-down. */
export function poolText(pool: MetricsPool): string {
  if (pool.at_risk === null) return `unknown (${pool.reason ?? 'reading missing'})`;
  const pct = (value: number | null): string => value === null ? 'unknown' : `${value}%`;
  return [`${pct(pool.used_pct)} used`, `${shown(pool.hours_to_reset)} h to reset`, `${pct(pool.projected_unused_pct)} projected unused`,
    pool.waste_risk ? `waste risk ${pool.waste_risk}` : pool.at_risk ? 'at risk' : 'on pace'].join(', ');
}

/** Pure: the plain-text view. */
export function metricsText(report: MetricsReport): string[] {
  const { merged_per_hour: pace, sources } = report;
  const period = report.hours === 1 ? 'last hour' : `last ${report.hours} hours`;
  const lines = [`Loop health, ${period}: ${report.headline}.`,
    `Merged per hour: ${shown(pace.last_1h)} (1 h), ${shown(pace.last_6h)} (6 h), ${shown(pace.last_24h)} (24 h).`];
  if (sources.jobs !== 'ok') lines.push('Cannot read the job metrics file, so merge pace, merge time and empty rate are unknown.');
  if (sources.status !== 'ok') lines.push(`The dispatcher status file is ${sources.status}${sources.status_as_of ? ` (last tick ${sources.status_as_of})` : ''}, so lanes, tiers and spend-down are unknown.`);
  if (report.lanes?.length) lines.push('Lanes, jobs launched in the last 24 hours:', ...report.lanes.map(lane =>
    `  ${lane.name}: ${shown(lane.jobs)} jobs, ${shown(lane.merged)} merged, ${percent(lane.empty_rate)} empty${lane.empty_high ? ' (over half empty)' : ''}, merge rate ${percent(lane.merge_rate)}`));
  else if (report.lanes) lines.push('Lanes: no jobs launched in the last 24 hours.');
  if (report.tiers?.length) lines.push(`Merge rate by tier: ${report.tiers.map(tier => `${tier.name} ${percent(tier.merge_rate)}`).join(', ')}.`);
  lines.push('Spend-down by pool:', ...report.pools.map(pool => `  ${pool.pool}: ${poolText(pool)}`));
  return lines;
}

/** The real sources under a runs directory (default ASHLR_RUNS_DIR or ~/.ashlr-runs). Read-only, bounded, never throws. */
export function metricsReader(runsDir = defaultRunsDir()): MetricsReader {
  return {
    status: async () => { try { return JSON.parse(await readText(join(runsDir, 'queue', 'status.json'), 1024 * 1024) ?? 'null') as unknown; } catch { return null; } },
    jobs: () => readText(join(runsDir, 'metrics', 'jobs.jsonl'), 32 * 1024 * 1024),
  };
}

export async function readMetrics(opts: { hours?: number; now?: number; reader?: MetricsReader } = {}): Promise<MetricsReport> {
  const reader = opts.reader ?? metricsReader();
  const [status, ledger] = await Promise.all([reader.status().catch(() => null), reader.jobs().catch(() => null)]);
  return buildMetrics({ status, ledger, now: opts.now ?? Date.now(), hours: opts.hours ?? 24 });
}
