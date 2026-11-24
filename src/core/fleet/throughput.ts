/**
 * `phm throughput`: what the fleet produced per hour (RQ-THROUGHPUTN17PQ8).
 *
 * One read of the job metrics file gives jobs launched, PRs published, PRs merged,
 * empty jobs and the median publish-to-merge time, per hour and per lane, repo,
 * tier or model (the model a job's launch row names). It reuses the `phm empties` readers (same rows, same empty rule) and the
 * main-guardian status. The desktop Throughput pane shows this exact report.
 * Anything not measured is null (JSON) or "unknown" (text), never zero.
 */
import { ledgerRows, readText, type LedgerRow } from './empty-cause.js';
import { finishesIn } from './empties.js';
import { readFleetMainHealth } from './main-health.js';
import { outcomePercentile } from './outcome-metrics.js';

export const THROUGHPUT_BY = ['lane', 'repo', 'tier', 'model'] as const;
export type ThroughputBy = (typeof THROUGHPUT_BY)[number];
export const THROUGHPUT_MAX_HOURS = 168;

export interface ThroughputCounts {
  launched: number | null; published: number | null; merged: number | null;
  /** Jobs that finished, the denominator of `empty_rate`. */
  finished: number | null;
  empty: number | null;
  /** Empty jobs over finished jobs, 0..1; null when none finished. */
  empty_rate: number | null;
  /** Median over merged PRs with a known publish time; null when none has one. */
  median_publish_to_merge_s: number | null;
  /** Merged PRs left out of the median because no publish time was recorded. */
  merge_time_unknown: number | null;
}
export interface ThroughputHour extends ThroughputCounts { start: string }
export interface ThroughputGroup { name: string; totals: ThroughputCounts; buckets: ThroughputHour[] }
export interface ThroughputReport {
  schema: 'throughput.v1';
  as_of: string; since: string; hours: number; by: ThroughputBy;
  metrics_path: string;
  metrics: 'ok' | 'unreadable';
  /** Lines that were not JSON objects: skipped and counted. Null when the file is unreadable. */
  malformed_lines: number | null;
  /** Default branches right now, from the main-guardian status; unknown when it is missing or stale. */
  main: 'green' | 'red' | 'unknown';
  headline: string;
  totals: ThroughputCounts;
  /** One per hour, oldest first; the last one ends at `as_of`. */
  buckets: ThroughputHour[];
  /** One per lane, repo, tier or model (`by`), sorted by name; `unknown` holds the work whose job record names none. */
  groups: ThroughputGroup[];
}

type Route = Record<ThroughputBy, string>;
interface Mark { kind: 'launched' | 'published' | 'merged' | 'finished'; at: number; route: Route; empty?: boolean; seconds?: number | null }

const HOUR = 3_600_000;
/** A PR merged in the window may have been launched and published well before it. */
const LOOKBACK_HOURS = 168;
const LEDGER_TAIL_BYTES = 32 * 1024 * 1024;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;
const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const label = (value: unknown): string | null => typeof value === 'string' && /^[\w][\w.:@/-]{0,79}$/.test(value.trim()) ? value.trim() : null;
/**
 * jobs.jsonl field dialects beyond the id/lane/ts sets ledgerRows already
 * accepts: the event name event|type|kind, the phase
 * phase|state|outcome|status|result|conclusion and the PR link
 * url|prUrl|pr_url|pr|html_url — the same aliases dispatchd `_vc_event`,
 * `_vc_phase` and `_vc_pr` read.
 */
const eventName = (row: Record<string, unknown>): string | null => {
  for (const key of ['event', 'type', 'kind'] as const) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};
const phaseName = (row: Record<string, unknown>): string | null => {
  for (const key of ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase();
  }
  return null;
};
const prLink = (row: Record<string, unknown>): string => {
  for (const key of ['url', 'prUrl', 'pr_url', 'pr', 'html_url'] as const) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};
/** `ashlrai/phantom` and `phantom` are one repo. */
const repoName = (value: unknown): string | null => label(value)?.split('/').pop()?.toLowerCase() || null;
/** A model id as the launch row wrote it (the same names `phm fleet lane-models` accepts); anything else is no name. */
const modelName = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(value.trim()) ? value.trim() : null;

/** Pure: validate the window and grouping for the CLI and the desktop API. Null when either is invalid. */
export function throughputOptions(hours?: string | null, by?: string | null): { hours: number; by: ThroughputBy } | null {
  const window = hours == null ? 24 : /^\d{1,3}$/.test(hours) ? Number(hours) : NaN;
  const group = THROUGHPUT_BY.find(name => name === (by ?? 'lane'));
  return window >= 1 && window <= THROUGHPUT_MAX_HOURS && group ? { hours: window, by: group } : null;
}

/** Pure: one mark per launch, per PR published, per PR merged and per job finished, at or after `since`. */
function marksOf(rows: readonly LedgerRow[], since: number, now: number, perLaunch = false): Mark[] {
  const routes = new Map<string, Partial<Route>>();
  const launches = new Map<string, { job: string; at: number }>();
  const prs = new Map<string, { job: string; repo: string | null; published?: number; merged?: number; ttm?: number }>();
  for (const { row, id, at } of rows) {
    const event = eventName(row) ?? (row.source === 'metrics-outcomes-reconciler' ? 'outcome' : null);
    if (id) {
      // The launch row decides a job's lane, repo, tier and model; other rows only fill gaps.
      const route = routes.get(id) ?? {};
      for (const [key, value] of [['lane', label(row.lane ?? row.pool ?? row.arm)], ['repo', repoName(row.repo)], ['tier', label(row.tier)], ['model', modelName(row.model)]] as const) {
        if (value && (event === 'launch' || !route[key])) route[key] = value;
      }
      routes.set(id, route);
      if (event === 'launch') launches.set(`${id}@${at}`, { job: id, at });
    }
    const merged = event === 'merged' || (event === 'outcome' && phaseName(row) === 'MERGED');
    const published = event === 'publish' || event === 'published';
    if (!merged && !published) continue;
    const url = PR_URL.exec(prLink(row));
    // A publish row without a PR link is an empty or aborted publish, not a PR.
    if (!url && (published || !id)) continue;
    // Re-emitted rows for one PR count once, at their earliest time.
    const key = url ? `${url[1]}#${url[2]}`.toLowerCase() : `job:${id}`;
    const pr = prs.get(key) ?? { job: id, repo: url ? repoName(url[1]) : null };
    pr.job ||= id;
    if (published) pr.published = Math.min(pr.published ?? Infinity, at);
    else {
      const stamp = typeof row.mergedAt === 'string' ? Date.parse(row.mergedAt) : NaN;
      pr.merged = Math.min(pr.merged ?? Infinity, Number.isFinite(stamp) && stamp <= now ? stamp : at);
      if (typeof row.ttm_s === 'number' && Number.isFinite(row.ttm_s) && row.ttm_s >= 0) pr.ttm ??= row.ttm_s;
    }
    prs.set(key, pr);
  }
  const routeOf = (job: string, repo?: string | null): Route => {
    const route = routes.get(job);
    return { lane: route?.lane ?? 'unknown', repo: repo ?? route?.repo ?? 'unknown', tier: route?.tier ?? 'unknown', model: route?.model ?? 'unknown' };
  };
  const marks: Mark[] = [...launches.values()].map(({ job, at }): Mark => ({ kind: 'launched', at, route: routeOf(job) }));
  for (const pr of prs.values()) {
    const route = routeOf(pr.job, pr.repo);
    if (pr.published !== undefined) marks.push({ kind: 'published', at: pr.published, route });
    // Publish and merge rows give the time directly; the recorded ttm_s stands in when the publish row is gone.
    if (pr.merged !== undefined) marks.push({ kind: 'merged', at: pr.merged, route,
      seconds: pr.published !== undefined && pr.published <= pr.merged ? (pr.merged - pr.published) / 1000 : pr.ttm ?? null });
  }
  const ended = rows.filter(row => row.at >= since);
  let finishes = finishesIn(ended);
  if (perLaunch) {
    // The work log counts how each launch ended, so a job launched twice has two endings and a skipped job has none.
    const runs = new Map<string, LedgerRow[]>(), launched = new Map<string, number>();
    for (const row of [...ended].sort((x, y) => x.at - y.at)) {
      const run = `${row.id}#${launched.set(row.id, (launched.get(row.id) ?? 0) + (eventName(row.row) === 'launch' ? 1 : 0)).get(row.id)}`;
      runs.set(run, [...(runs.get(run) ?? []), row]);
    }
    finishes = [...runs.values()].flatMap(run => finishesIn(run)).filter(finish => !finish.skipped);
  }
  for (const finish of finishes) marks.push({ kind: 'finished', at: finish.at, route: routeOf(finish.id), empty: finish.empty });
  return marks.filter(mark => mark.at >= since && mark.at <= now);
}

export type ThroughputMark = Mark;
/** Pure: the marks between `since` and `now` and the count of skipped lines. `phm fleet worklog` buckets these same marks, with one ending per launch. */
export function throughputMarks(ledger: string, since: number, now: number, perLaunch = false): { marks: Mark[]; malformed: number } {
  const read = ledgerRows(ledger, now, (now - since) / HOUR + LOOKBACK_HOURS, true);
  return { marks: marksOf(read.rows, since, now, perLaunch), malformed: read.malformed };
}

function counts(marks: readonly Mark[]): ThroughputCounts {
  const count = (kind: Mark['kind']) => marks.filter(mark => mark.kind === kind).length;
  const times = marks.flatMap(mark => mark.kind === 'merged' && mark.seconds != null ? [mark.seconds] : []);
  const merged = count('merged'), finished = count('finished'), empty = marks.filter(mark => mark.empty).length;
  const median = outcomePercentile(times, 0.5);
  return {
    launched: count('launched'), published: count('published'), merged, finished, empty,
    empty_rate: finished ? Math.round((empty / finished) * 1000) / 1000 : null,
    median_publish_to_merge_s: median === null ? null : Math.round(median),
    merge_time_unknown: merged - times.length,
  };
}

/** "2m 50s"; null is "unknown". */
export function durationText(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  return whole < 3600 ? `${Math.floor(whole / 60)}m ${whole % 60}s` : `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

/** Pure: build the report. `ledger` null means the metrics file was unreadable, so every count is null. */
export function buildThroughput(input: { ledger: string | null; now: number; hours: number; by: ThroughputBy; metricsPath: string; main?: ThroughputReport['main'] }): ThroughputReport {
  const { now, hours, by } = input;
  const since = now - hours * HOUR;
  const read = input.ledger === null ? null : throughputMarks(input.ledger, since, now);
  const all = read && read.marks;
  const section = (marks: readonly Mark[] | null): { totals: ThroughputCounts; buckets: ThroughputHour[] } => {
    const slots = Array.from({ length: hours }, (): Mark[] => []);
    for (const mark of marks ?? []) slots[Math.min(hours - 1, Math.floor((mark.at - since) / HOUR))]!.push(mark);
    return {
      totals: marks ? counts(marks) : NONE,
      buckets: slots.map((slot, i) => ({ start: new Date(since + i * HOUR).toISOString(), ...(marks ? counts(slot) : NONE) })),
    };
  };
  const names = [...new Set((all ?? []).map(mark => mark.route[by]))].sort((a, b) => a.localeCompare(b));
  const whole = section(all);
  const window = hours === 1 ? 'the last hour' : `the last ${hours} hours`;
  return {
    schema: 'throughput.v1', as_of: new Date(now).toISOString(), since: new Date(since).toISOString(), hours, by,
    metrics_path: input.metricsPath, metrics: read ? 'ok' : 'unreadable', malformed_lines: read?.malformed ?? null,
    main: input.main ?? 'unknown',
    headline: whole.totals.merged === null ? `Merged in ${window}: unknown (cannot read the job metrics file)`
      : `${whole.totals.merged} merged in ${window}, median ${durationText(whole.totals.median_publish_to_merge_s)}`,
    ...whole,
    groups: names.map(name => ({ name, ...section(all!.filter(mark => mark.route[by] === name)) })),
  };
}

const shown = (value: number | null): string => value === null ? 'unknown' : String(value);
const line = (c: ThroughputCounts): string => `launched ${shown(c.launched)}, published ${shown(c.published)}, merged ${shown(c.merged)}, ${
  c.finished === null ? 'empty unknown' : c.finished ? `empty ${c.empty} of ${c.finished} finished (${Math.round((c.empty_rate ?? 0) * 100)}%)` : 'none finished'
}, median merge ${durationText(c.median_publish_to_merge_s)}`;

/** Pure: the `--text` view. Hours in which nothing happened are left out and counted. */
export function throughputText(report: ThroughputReport): string[] {
  const lines = [`${report.headline}.`, `As of ${report.as_of}: ${line(report.totals)}. Main is ${report.main}.`];
  if (report.metrics !== 'ok') return [...lines, `Cannot read the job metrics file ${report.metrics_path}.`];
  const busy = report.buckets.filter(hour => hour.launched || hour.published || hour.merged || hour.finished);
  if (busy.length) lines.push('By hour (UTC start):', ...busy.map(hour => `  ${hour.start.slice(0, 16).replace('T', ' ')}: ${line(hour)}`));
  if (busy.length < report.hours) lines.push(!busy.length ? 'No jobs or PRs were recorded.' : `Quiet hours left out: ${report.hours - busy.length}.`);
  if (report.groups.length) lines.push(`By ${report.by}:`, ...report.groups.map(group => `  ${group.name}: ${line(group.totals)}`));
  if (report.totals.merge_time_unknown) lines.push(`Merged PRs with no publish time, left out of the median: ${report.totals.merge_time_unknown}.`);
  if (report.malformed_lines) lines.push(`Metrics lines that could not be read and were skipped: ${report.malformed_lines}.`);
  return lines;
}

/** Read the metrics file and the main-guardian status. Read-only; never throws. */
export async function readThroughput(opts: { metricsPath: string; runsDir: string; hours: number; by: ThroughputBy; now: number }): Promise<ThroughputReport> {
  const [ledger, health] = await Promise.all([
    readText(opts.metricsPath, LEDGER_TAIL_BYTES),
    readFleetMainHealth({ runsDir: opts.runsDir, now: () => opts.now }).catch(() => null),
  ]);
  const main = !health || health.source !== 'ok' || health.stale ? 'unknown' : health.red > 0 ? 'red'
    : health.repos.length && health.repos.every(repo => repo.state === 'green') ? 'green' : 'unknown';
  return buildThroughput({ ledger, now: opts.now, hours: opts.hours, by: opts.by, metricsPath: opts.metricsPath, main });
}
