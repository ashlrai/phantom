/**
 * core/fleet/goal-scorecard.ts: the fleet's standing goals (RQ-GOALSVIEWN17EQ8).
 * One row per goal with a target, the current value, when and where it was
 * read, 24-hour and 7-day trends and a status (RQ-GOALSVIEWN17EVQ8: v2). Shared by `phm goals` and the desktop
 * Goals view (`GET /api/verse/fleet/runs/goal-scorecard`), so both agree.
 *
 * Every number comes from a file Phantom already writes under the runs dir:
 * metrics/jobs.jsonl (merges, publish-to-merge, empty finishes),
 * queue/status.json `budget` (included usage pools), the main guardian table and
 * metrics/growth-releases.jsonl (releases). Read-only. A missing, unreadable
 * or stale signal is `unknown`, never zero.
 */
import { join } from 'node:path';
import { readGrowthJsonl } from '../growth/read.js';
import { runsRoot } from '../metrics/loop-collect.js';
import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { readFleetMainHealth, type FleetMainHealthV1 } from './main-health.js';
import { isIncludedLane } from '../usage/sensor-reading.js';
import { metricsSeriesTally, type FleetMetricsSeries } from './metrics-series.js';
import { readSource } from './runs-parked-queue.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The goals' targets: one small typed config. Override per call (tests, a future config file); never per goal. */
export interface GoalTargets {
  /** PRs merged per hour, rolling 24 h. */
  mergesPerHour: number;
  /** Median minutes from publish to merge, rolling 24 h. */
  publishToMergeMinutes: number;
  /** Share of finished jobs that changed nothing, 0 to 1. */
  emptyFinishRate: number;
  mainGreenPercent: number;
  /** Releases every releasing repo ships in a rolling 7 days. */
  releasesPerRepoPer7d: number;
  /** Included pools follow the Nov 5, 2026 no-reserve order: spend the pool before it resets. */
  poolUsedByResetPercent: number;
}
export const DEFAULT_GOAL_TARGETS: Readonly<GoalTargets> = Object.freeze({
  mergesPerHour: 4,
  publishToMergeMinutes: 60,
  emptyFinishRate: 0.2,
  mainGreenPercent: 100,
  releasesPerRepoPer7d: 1,
  poolUsedByResetPercent: 90,
});
/** A pool reading older than this no longer says how the pool is doing. */
export const POOL_READING_STALE_MS = 6 * HOUR;
export const GOAL_SCORECARD_VERSION = 2;

export type GoalStatus = 'on-track' | 'behind' | 'unknown';
export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';
export interface GoalTrend {
  /** Oldest first; null is a bucket without data. Empty when the source keeps no history. */
  points: (number | null)[];
  direction: TrendDirection;
  /** The target in the points' unit, for a target line; null when the points are not comparable to it. */
  target: number | null;
}
export interface FleetGoal {
  /** Stable across runs; pools are `pool-<name>`. */
  id: string;
  title: string;
  target: string;
  targetValue: number;
  better: 'higher' | 'lower';
  value: number | null;
  /** Plain words; "unknown" when value is null. */
  valueText: string;
  asOf: string | null;
  /** File under the runs dir the value came from. */
  source: string;
  /** 24 hourly points. */
  trend24h: GoalTrend;
  /** 7 daily points. */
  trend7d: GoalTrend;
  status: GoalStatus;
  /** "on track", "behind" or "unknown: <reason>". */
  statusText: string;
  /** One plain sentence: why this status. */
  why: string;
  /** Per-repo (or other) breakdown behind the value; empty when there is none. */
  parts: { name: string; value: number }[];
  /** Desktop pane that shows the underlying evidence. */
  evidencePane: string;
}
export interface GoalScorecard {
  schema: 'fleet.goal-scorecard.v2';
  version: typeof GOAL_SCORECARD_VERSION;
  generatedAt: string;
  /** Lines in metrics/jobs.jsonl or growth-releases.jsonl that could not be read; they are skipped. */
  malformedLines: number;
  targets: GoalTargets;
  /** Behind first, then unknown, then on track; ties keep their natural order. */
  goals: FleetGoal[];
}

/** What one pass over metrics/jobs.jsonl learned. Null fields mean the ledger was not read. */
export interface JobsFacts {
  series: FleetMetricsSeries;
  /** Newest valid row time, ms; null when no row fell in the last 24 hours. */
  latestAt: number | null;
  /** The last 7 days, so the 24 h value and both trends come from one pass. */
  merges: { at: number }[];
  publishToMerge: { at: number; minutes: number }[];
  finishes: { at: number; empty: boolean }[];
}

const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const num = (v: unknown, max = Infinity): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const time = (v: unknown): number | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const round = (n: number, places = 1): number => Math.round(n * 10 ** places) / 10 ** places;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;

/** Streaming tally over jobs.jsonl lines; the 24 h merge count and malformed lines reuse the metrics series. */
export function jobsGoalTally(now: number) {
  const since24 = now - DAY;
  const since7 = now - 7 * DAY;
  const series = metricsSeriesTally(now);
  const published = new Map<string, number>();
  const merged = new Map<string, number>();
  /** Same identity as the metrics series: the PR url when present, else the job. */
  const mergedPrs = new Map<string, number>();
  const finishes = new Map<string, { at: number; empty: boolean }>();
  let latestAt: number | null = null;
  const keepFirst = (map: Map<string, number>, key: string, at: number) => { if (!map.has(key) || at < map.get(key)!) map.set(key, at); };
  return {
    add(line: string): void {
      series.add(line);
      let r: Record<string, unknown>;
      try { r = rec(JSON.parse(line)); } catch { return; } // counted by the series tally
      const at = time(r.ts ?? r.at);
      const job = r.job ?? r.jobId ?? r.job_id ?? r.id;
      if (at === null || at > now) return;
      if (at >= since24) latestAt = Math.max(latestAt ?? at, at);
      if (typeof job !== 'string' || !job) return;
      const state = String(r.state ?? r.outcome ?? r.status ?? '').toUpperCase();
      if (r.event === 'publish') keepFirst(published, job, at);
      else if (r.event === 'outcome' && state === 'MERGED') {
        keepFirst(merged, job, at);
        const url = r.url ?? r.prUrl ?? r.pr_url ?? r.pr;
        const m = typeof url === 'string' ? PR_URL.exec(url) : null;
        keepFirst(mergedPrs, m ? `${m[1]!.toLowerCase()}/pull/${m[2]}` : `job:${job}`, at);
      } else if (r.event === 'finish' && at >= since7) finishes.set(`${job}\n${at}`, { at, empty: r.empty === true });
    },
    report(known: boolean): JobsFacts | null {
      if (!known) return null;
      const publishToMerge = [...merged].flatMap(([job, at]) => {
        const from = published.get(job);
        return at >= since7 && from !== undefined && from <= at ? [{ at, minutes: (at - from) / 60_000 }] : [];
      });
      const merges = [...mergedPrs.values()].filter(at => at >= since7).map(at => ({ at }));
      return { series: series.report(true), latestAt, merges, publishToMerge, finishes: [...finishes.values()] };
    },
  };
}

/** `count` equal buckets of `size` ms ending at `now`; null is a bucket without rows. */
function buckets<T>(rows: readonly (T & { at: number })[], now: number, count: number, size: number, value: (rows: T[]) => number | null): (number | null)[] {
  const since = now - count * size;
  const out: T[][] = Array.from({ length: count }, () => []);
  for (const row of rows) if (row.at >= since && row.at <= now) out[Math.min(count - 1, Math.floor((row.at - since) / size))]!.push(row);
  return out.map(b => b.length ? value(b) : null);
}
const within = <T extends { at: number }>(rows: readonly T[], now: number, span: number) => rows.filter(r => r.at >= now - span && r.at <= now);

/** Earlier half against the later half: a 10% relative change is a direction. */
export function trendDirection(points: readonly (number | null)[]): TrendDirection {
  const avg = (xs: readonly (number | null)[]) => {
    const k = xs.filter((x): x is number => x !== null);
    return k.length ? k.reduce((a, b) => a + b, 0) / k.length : null;
  };
  const half = points.length >> 1;
  const before = avg(points.slice(0, half)); const after = avg(points.slice(half));
  if (before === null || after === null) return 'unknown';
  const scale = Math.max(Math.abs(before), Math.abs(after));
  return scale === 0 || Math.abs(after - before) / scale < 0.1 ? 'flat' : after > before ? 'up' : 'down';
}
const trend = (points: (number | null)[], target: number | null): GoalTrend => ({ points, direction: trendDirection(points), target });
const NO_TREND: GoalTrend = { points: [], direction: 'unknown', target: null };

/** "unknown: the jobs ledger could not be read" from "The jobs ledger could not be read." */
export function statusText(status: GoalStatus, why: string): string {
  if (status !== 'unknown') return status === 'on-track' ? 'on track' : 'behind';
  const reason = why.trim().replace(/\.$/, '');
  return `unknown: ${reason ? reason[0]!.toLowerCase() + reason.slice(1) : 'no reading yet'}`;
}

interface Draft {
  id: string; title: string; target: string; targetValue: number; better: 'higher' | 'lower';
  value: number | null; valueText: string; asOf: string | null; source: string; evidencePane: string;
  trend24h?: GoalTrend; trend7d?: GoalTrend; parts?: { name: string; value: number }[];
  status?: GoalStatus; why?: string; ok: string; short: string;
}
/** Fill status from value against target; an explicit status (unknown/stale) wins. */
function goal(d: Draft): FleetGoal {
  const status: GoalStatus = d.status ?? (d.value === null ? 'unknown'
    : (d.better === 'higher' ? d.value >= d.targetValue : d.value <= d.targetValue) ? 'on-track' : 'behind');
  const why = d.why ?? (status === 'unknown' ? 'No reading yet.' : status === 'on-track' ? d.ok : d.short);
  return {
    id: d.id, title: d.title, target: d.target, targetValue: d.targetValue, better: d.better, value: d.value,
    valueText: d.value === null ? 'unknown' : d.valueText, asOf: d.asOf, source: d.source,
    trend24h: d.trend24h ?? NO_TREND, trend7d: d.trend7d ?? NO_TREND, status, statusText: statusText(status, why), why,
    parts: d.parts ?? [], evidencePane: d.evidencePane,
  };
}

const STATUS_RANK: Record<GoalStatus, number> = { behind: 0, unknown: 1, 'on-track': 2 };
/** Behind first, then unknown, then on track; stable within a status. */
export const orderGoals = (goals: readonly FleetGoal[]): FleetGoal[] =>
  goals.map((g, i) => [g, i] as const).sort(([a, i], [b, j]) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || i - j).map(([g]) => g);

/** The repo a release row names: `repo`, `repository`, or a github.com url. */
function releaseRepo(r: Record<string, unknown>): string {
  const named = typeof r.repo === 'string' ? r.repo : typeof r.repository === 'string' ? r.repository : null;
  if (named && /^[\w.-]+(\/[\w.-]+)?$/.test(named)) return named.toLowerCase();
  const url = typeof r.url === 'string' ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\//i.exec(r.url) : null;
  return url ? url[1]!.toLowerCase() : 'repo not recorded';
}

export interface GoalScorecardInput {
  now: number;
  /** Null when metrics/jobs.jsonl could not be read. */
  jobs: JobsFacts | null;
  /** Parsed queue/status.json; null when unreadable. */
  status: unknown;
  mains: FleetMainHealthV1 | null;
  /** growth-releases.jsonl lines; null when the file could not be read. */
  releaseLines: readonly string[] | null;
  targets?: Partial<GoalTargets>;
}

export function buildGoalScorecard(input: GoalScorecardInput): GoalScorecard {
  const { now, jobs, mains } = input;
  const T: GoalTargets = { ...DEFAULT_GOAL_TARGETS, ...input.targets };
  const goals: FleetGoal[] = [];
  const jobsAsOf = iso(jobs?.latestAt ?? null);
  const quiet = jobs !== null && jobs.latestAt === null;
  const noJobs = jobs === null ? 'The jobs ledger could not be read.' : quiet ? 'No jobs were recorded in the last 24 hours.' : undefined;
  const unknownIf = (cond: boolean) => (cond || noJobs ? { status: 'unknown' as const, why: noJobs } : {});
  const hourly = <R extends { at: number }>(rows: readonly R[], value: (rows: R[]) => number | null) => jobs && !quiet ? buckets(rows, now, 24, HOUR, value) : [];
  const daily = <R extends { at: number }>(rows: readonly R[], value: (rows: R[]) => number | null) => jobs ? buckets(rows, now, 7, DAY, value) : [];

  const merges24 = jobs && !quiet ? jobs.series.mergesLast24h : null;
  const perHour = merges24 === null ? null : round(merges24 / 24, 2);
  goals.push(goal({
    id: 'merges-per-hour', title: 'PRs merged per hour', target: `${T.mergesPerHour} or more an hour`, targetValue: T.mergesPerHour, better: 'higher',
    value: perHour, valueText: `${perHour} an hour (${merges24} in 24 h)`, asOf: jobsAsOf, source: 'metrics/jobs.jsonl',
    trend24h: trend(jobs && !quiet ? jobs.series.hours.map(h => h.merged) : [], T.mergesPerHour),
    // Days with no merge are a real zero once the ledger was read.
    trend7d: trend(daily(jobs?.merges ?? [], rows => round(rows.length / 24, 2)).map(v => v ?? 0), T.mergesPerHour),
    evidencePane: 'fleet-metrics', ...unknownIf(false), ok: 'Merging at or above target.', short: 'Merging below target.',
  }));

  const ptm = jobs?.publishToMerge ?? [];
  const minutes = median(within(ptm, now, DAY).map(p => p.minutes));
  const medianOf = (rows: { minutes: number }[]) => round(median(rows.map(r => r.minutes))!);
  goals.push(goal({
    id: 'publish-to-merge', title: 'Median time from publish to merge', target: `${T.publishToMergeMinutes} minutes or less`,
    targetValue: T.publishToMergeMinutes, better: 'lower',
    value: minutes === null ? null : round(minutes), valueText: `${minutes === null ? '' : round(minutes)} minutes`, asOf: jobsAsOf, source: 'metrics/jobs.jsonl',
    trend24h: trend(hourly(ptm, medianOf), T.publishToMergeMinutes), trend7d: trend(daily(ptm, medianOf), T.publishToMergeMinutes), evidencePane: 'fleet-merges',
    ...unknownIf(minutes === null), ...(minutes === null && !noJobs ? { why: 'No merged PR with a recorded publish time in the last 24 hours.' } : {}),
    ok: 'PRs merge quickly after publish.', short: 'PRs wait too long to merge.',
  }));

  const finished = within(jobs?.finishes ?? [], now, DAY);
  const emptyRate = finished.length ? finished.filter(f => f.empty).length / finished.length : null;
  const rateOf = (rows: { empty: boolean }[]) => round(rows.filter(r => r.empty).length / rows.length, 3);
  goals.push(goal({
    id: 'empty-finish-rate', title: 'Jobs that finish with no change', target: `${T.emptyFinishRate * 100}% or less`, targetValue: T.emptyFinishRate, better: 'lower',
    value: emptyRate === null ? null : round(emptyRate, 3), valueText: `${emptyRate === null ? '' : round(emptyRate * 100)}% of ${finished.length} finishes`,
    asOf: jobsAsOf, source: 'metrics/jobs.jsonl',
    trend24h: trend(hourly(jobs?.finishes ?? [], rateOf), T.emptyFinishRate), trend7d: trend(daily(jobs?.finishes ?? [], rateOf), T.emptyFinishRate),
    evidencePane: 'fleet-metrics', ...unknownIf(emptyRate === null), ...(emptyRate === null && !noJobs ? { why: 'No job finished in the last 24 hours.' } : {}),
    ok: 'Few jobs finish empty.', short: 'Too many jobs finish empty.',
  }));

  const repos = mains?.source === 'ok' ? mains.repos : [];
  const green = repos.filter(r => r.state === 'green').length;
  const red = repos.filter(r => r.state === 'red');
  const greenPct = repos.length ? round(green / repos.length * 100) : null;
  goals.push(goal({
    id: 'main-green', title: 'Main branch green in every repo', target: 'All repos green', targetValue: T.mainGreenPercent, better: 'higher',
    value: greenPct, valueText: `${green} of ${repos.length} green`, asOf: mains?.statusAt ?? null, source: 'supervisor/status-main-guardian.md',
    evidencePane: 'fleet-mission',
    ...(!repos.length ? { status: 'unknown' as const, why: 'The main guardian table could not be read.' }
      : mains!.stale ? { status: 'unknown' as const, why: 'The main guardian table is stale.' }
      : red.length ? { status: 'behind' as const, why: `Red: ${red.slice(0, 4).map(r => r.repo).join(', ')}${red.length > 4 ? ` and ${red.length - 4} more` : ''}.` }
      : green < repos.length ? { status: 'unknown' as const, why: 'Some repos have no known state.' } : {}),
    ok: 'Every main branch is green.', short: 'Some main branches are red.',
  }));

  let malformedLines = jobs?.series.malformedLines ?? 0;
  const releases: { at: number; repo: string }[] = [];
  for (const line of input.releaseLines ?? []) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> = {};
    try { row = rec(JSON.parse(line)); } catch { /* counted below */ }
    const at = time(row.publishedAt);
    if (at === null) malformedLines++; else if (at <= now) releases.push({ at, repo: releaseRepo(row) });
  }
  // Every repo that has ever released is expected to keep releasing.
  const week = within(releases, now, 7 * DAY);
  const parts = [...new Set(releases.map(r => r.repo))].sort()
    .map(name => ({ name, value: week.filter(r => r.repo === name).length }))
    .sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));
  const short = parts.filter(p => p.value < T.releasesPerRepoPer7d);
  const last = releases.length ? Math.max(...releases.map(r => r.at)) : null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  goals.push(goal({
    id: 'releases-7d', title: 'Releases in the last 7 days, per repo', target: `${plural(T.releasesPerRepoPer7d, 'release')} or more per repo`,
    targetValue: T.releasesPerRepoPer7d, better: 'higher',
    value: parts.length ? Math.min(...parts.map(p => p.value)) : null,
    valueText: `${plural(week.length, 'release')} across ${plural(parts.length, 'repo')}; fewest in one repo: ${parts[0]?.value ?? 0}`,
    asOf: iso(last), source: 'metrics/growth-releases.jsonl', parts,
    trend24h: trend(input.releaseLines === null ? [] : buckets(releases, now, 24, HOUR, rows => rows.length).map(n => n ?? 0), null),
    trend7d: trend(input.releaseLines === null ? [] : buckets(releases, now, 7, DAY, rows => rows.length).map(n => n ?? 0), null),
    evidencePane: 'fleet-releases',
    ...(input.releaseLines === null ? { status: 'unknown' as const, why: 'The release log could not be read.' }
      : !parts.length ? { status: 'unknown' as const, why: 'No release is recorded.' }
      : short.length ? { status: 'behind' as const, why: `Too few releases: ${short.slice(0, 4).map(p => `${p.name} (${p.value})`).join(', ')}${short.length > 4 ? ` and ${short.length - 4} more` : ''}.` } : {}),
    ok: 'Every repo is releasing on time.', short: 'The release train is behind.',
  }));

  const status = rec(input.status);
  const statusAt = time(status.last_tick);
  for (const [name, raw] of Object.entries(rec(status.budget)).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isIncludedLane(name)) continue; // metered lanes are not a "spend it before reset" goal
    const id = `pool-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
    if (id === 'pool-' || goals.some(g => g.id === id)) continue;
    const row = rec(raw);
    const used = num(row.weekly_used_pct ?? row.used_pct, 100);
    const reset = time(row.reset_at);
    const burn = num(row.burn_pct_per_hour);
    const at = time(row.as_of) ?? statusAt;
    const left = reset === null ? null : (reset - now) / HOUR;
    const projected = used === null || burn === null || left === null ? null : Math.min(100, used + burn * left);
    const whyUnknown = used === null ? 'No usage reading.' : reset === null ? 'The reset time is unknown.' : left! <= 0 ? 'The pool has reset since this reading.'
      : at === null || now - at > POOL_READING_STALE_MS ? 'The usage reading is old.' : burn === null ? 'The burn rate is unknown, so the pace is unknown.' : null;
    goals.push(goal({
      id, title: `${name} pool spent before it resets`, target: `${T.poolUsedByResetPercent}% or more used by reset`,
      targetValue: T.poolUsedByResetPercent, better: 'higher',
      value: used, valueText: `${used}% used${left !== null && left > 0 ? `, resets in ${left < 48 ? `${round(left)} hours` : `${round(left / 24)} days`}` : ''}${projected === null ? '' : `, on pace for ${round(projected)}%`}`,
      asOf: iso(at), source: 'queue/status.json', evidencePane: 'fleet-usage',
      ...(whyUnknown ? { status: 'unknown' as const, why: whyUnknown }
        : { status: projected! >= T.poolUsedByResetPercent ? 'on-track' as const : 'behind' as const }),
      ok: 'On pace to use the pool before it resets.', short: 'On pace to leave part of the pool unused.',
    }));
  }
  return { schema: 'fleet.goal-scorecard.v2', version: GOAL_SCORECARD_VERSION, generatedAt: new Date(now).toISOString(), malformedLines, targets: T, goals: orderGoals(goals) };
}

export interface ReadGoalScorecardOptions {
  runsDir?: string; now?: () => number; targets?: Partial<GoalTargets>;
  /** The injectable readers: tests pass fixtures, production reads the runs dir. */
  readLines?: YieldLineReader;
  readStatus?: (path: string) => Promise<unknown>;
  readMains?: (root: string, now: number) => Promise<FleetMainHealthV1 | null>;
  readReleaseLines?: (path: string) => Promise<readonly string[] | null>;
}

const readStatusJson = (path: string): Promise<unknown> => readSource(path, 1024 * 1024, false)
  .then(s => s.state === 'healthy' ? JSON.parse(s.text) as unknown : null);

export async function readGoalScorecard(opts: ReadGoalScorecardOptions = {}): Promise<GoalScorecard> {
  const root = opts.runsDir ?? runsRoot();
  const now = (opts.now ?? Date.now)();
  const tally = jobsGoalTally(now);
  const [known, status, mains, releaseLines] = await Promise.all([
    (opts.readLines ?? readLedgerLines)(join(root, 'metrics', 'jobs.jsonl'), line => tally.add(line)).catch(() => false),
    (opts.readStatus ?? readStatusJson)(join(root, 'queue', 'status.json')).catch(() => null),
    (opts.readMains ?? ((runsDir, at) => readFleetMainHealth({ runsDir, now: () => at })))(root, now).catch(() => null),
    (opts.readReleaseLines ?? readGrowthJsonl)(join(root, 'metrics', 'growth-releases.jsonl')).catch(() => null),
  ]);
  return buildGoalScorecard({ now, jobs: tally.report(known), status, mains, releaseLines, ...(opts.targets ? { targets: opts.targets } : {}) });
}

const ARROWS: Record<TrendDirection, string> = { up: 'rising', down: 'falling', flat: 'steady', unknown: 'no trend yet' };

/** Plain text for people: one block per goal, behind first. */
export function renderGoalScorecard(card: GoalScorecard): string {
  if (!card.goals.length) return 'No goals yet.';
  const lines = card.goals.flatMap(g => [
    `${g.title}: ${g.statusText}`,
    `  Now ${g.valueText} · target ${g.target} · 24 h ${ARROWS[g.trend24h.direction]} · 7 d ${ARROWS[g.trend7d.direction]}`,
    ...(g.status === 'unknown' ? [] : [`  ${g.why}`]),
    `  As of ${g.asOf ?? 'unknown'} from ${g.source}.`,
  ]);
  if (card.malformedLines) lines.push(`${card.malformedLines} unreadable metrics line${card.malformedLines === 1 ? ' was' : 's were'} skipped.`);
  return lines.join('\n');
}
