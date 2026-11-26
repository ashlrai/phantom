/**
 * core/fleet/goal-scorecard.ts: the fleet's self-managed goals (RQ-GOALSVIEWN17EQ8,
 * v2 RQ-GOALSVIEWN17EVQ8, v3 RQ-GOALSVIEWN19LQ8). One row per goal: why it
 * matters, the number now, the target, the trend, when and where it was read.
 * Shared by `phm goals [--json]` and the desktop and phone Goals views
 * (`GET /api/verse/fleet/runs/goal-scorecard`), so all three agree.
 *
 * Every number comes from a file Phantom already writes under the runs dir:
 * metrics/jobs.jsonl (launches, merges, publish-to-merge), queue/status.json
 * `budget` (included usage pools), the main guardian table and
 * metrics/growth-releases.jsonl (releases). Read-only; nothing is typed in by
 * hand. A missing, unreadable or stale signal is `unknown`, never zero.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readGrowthJsonl } from '../growth/read.js';
import { runsRoot } from '../metrics/loop-collect.js';
import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { readFleetMainHealth, type FleetMainHealthV1 } from './main-health.js';
import { isIncludedLane } from '../usage/sensor-reading.js';
import { metricsSeriesTally, type FleetMetricsSeries } from './metrics-series.js';
import { readSource } from './runs-parked-queue.js';
import { TREND_MARK, type TrendDirection } from './goal-trend.js';

export { TREND_MARK, type TrendDirection } from './goal-trend.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The goals' targets: one small typed config. Override per call (tests, a future config file); never per goal. */
export interface GoalTargets {
  /** PRs merged in a rolling 24 hours. */
  mergesPerDay: number;
  /** Median minutes from PR opened (published) to merged, rolling 24 h. */
  publishToMergeMinutes: number;
  /** Percent of settled job launches that end in a merged PR. */
  launchesMergedPercent: number;
  /** Releases every releasing repo ships in a rolling 7 days. */
  releasesPerRepoPer7d: number;
  /** Included pools follow the Nov 5, 2026 no-reserve order: spend the pool before it resets. */
  poolUsedByResetPercent: number;
  /** Largest share of finished jobs in a rolling 24 hours that may end EMPTY (0 to 1). */
  wastedLaunchRate: number;
}
export const DEFAULT_GOAL_TARGETS: Readonly<GoalTargets> = Object.freeze({
  mergesPerDay: 96,
  publishToMergeMinutes: 60,
  launchesMergedPercent: 50,
  releasesPerRepoPer7d: 1,
  poolUsedByResetPercent: 90,
  wastedLaunchRate: 0.2,
});
/** A pool reading older than this no longer says how the pool is doing. */
export const POOL_READING_STALE_MS = 6 * HOUR;
/** A launch younger than this may still merge, so it is not judged yet. */
export const LAUNCH_SETTLE_MS = DAY;
export const GOAL_SCORECARD_VERSION = 3;

export type GoalStatus = 'on-track' | 'behind' | 'unknown';
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
  /** One plain sentence: why this goal matters. Fixed per goal. */
  why: string;
  /** What is measured, in plain words. */
  metric: string;
  /** Unit of `current` and `target`. */
  unit: string;
  /** The target in `unit`; null when it depends on data that is missing (how many repos there are). */
  target: number | null;
  /** The target in plain words. */
  targetText: string;
  better: 'higher' | 'lower';
  /** Null is unknown, never zero. */
  current: number | null;
  /** Plain words; "unknown" when current is null. */
  currentText: string;
  /** The headline trend: the 7-day direction, else the 24-hour one. */
  trend: TrendDirection;
  /** 24 hourly points. */
  trend24h: GoalTrend;
  /** 7 daily points. */
  trend7d: GoalTrend;
  updated_at: string | null;
  /** File under the runs dir the value came from. */
  source: string;
  status: GoalStatus;
  /** "on track", "behind" or "unknown: <reason>". */
  statusText: string;
  /** One plain sentence: why this status. */
  reason: string;
  /** Per-repo (or other) breakdown behind the value; empty when there is none. */
  parts: { name: string; value: number }[];
  /** Desktop pane that shows the underlying evidence. */
  evidencePane: string;
  /** The next planned step linked to this goal (`GoalScorecardInput.nextSteps`); null when none is linked. */
  next: string | null;
}
export interface GoalScorecard {
  schema: 'fleet.goal-scorecard.v3';
  version: typeof GOAL_SCORECARD_VERSION;
  generatedAt: string;
  /** Lines in metrics/jobs.jsonl or growth-releases.jsonl that could not be read; they are skipped. */
  malformedLines: number;
  targets: GoalTargets;
  /** One plain sentence: is the fleet heading where it should. */
  endState: string;
  /** Behind first, then unknown, then on track; ties keep their natural order. */
  goals: FleetGoal[];
  /** Additive (RQ-GOALSV4N21AQ8), still v3: v3 readers ignore these. The vision file's first line; null when there is no vision file. */
  end_state_text?: string | null;
  /** The leader's current READY bets, in file order; empty when the vision file is missing or has none. */
  bets?: GoalBet[];
  /** Vision file the bets came from, relative to the runs dir; null when it could not be read. */
  bets_source?: string | null;
  /** Plain reason when `bets` is empty or the file is missing; null otherwise. */
  bets_reason?: string | null;
  /** When the vision file was last written; null when unknown. */
  as_of?: string | null;
}
export interface GoalBet { id: string; pool: string | null; repo: string | null; goal: string }
export const VISION_SOURCE = 'leader/VISION.md';
const MAX_BETS = 100;

/** `- READY RQ-X (P1, pool=claude, tier=work, repo=phantom, ...): goal text` lines, in file order, first of an id wins. */
export function parseVisionBets(text: string): GoalBet[] {
  const bets: GoalBet[] = []; const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^- READY (RQ-[A-Za-z0-9_-]+)\s*(?:\(([^)]*)\))?\s*:?\s*(.*)$/.exec(line);
    if (!m || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    const meta = m[2] ?? '';
    const field = (k: string) => new RegExp(`(?:^|,\\s*)${k}=([A-Za-z0-9._/-]+)`).exec(meta)?.[1] ?? null;
    bets.push({ id: m[1]!, pool: field('pool'), repo: field('repo'), goal: m[3]!.trim().slice(0, 400) });
    if (bets.length >= MAX_BETS) break;
  }
  return bets;
}
/** The vision's first non-empty line, without markdown heading marks; null when there is none. */
export const visionEndState = (text: string): string | null =>
  text.split(/\r?\n/).map(l => l.trim()).find(Boolean)?.replace(/^#+\s*/, '').slice(0, 300) || null;

/** What one pass over metrics/jobs.jsonl learned. Null fields mean the ledger was not read. */
export interface JobsFacts {
  series: FleetMetricsSeries;
  /** Newest valid row time, ms; null when no row fell in the last 24 hours. */
  latestAt: number | null;
  /** The last 7 days, so the 24 h value and both trends come from one pass. */
  merges: { at: number }[];
  publishToMerge: { at: number; minutes: number }[];
  /** Jobs launched 8 to 1 days ago (settled), by launch time, and whether each merged a PR. */
  launches: { at: number; merged: boolean }[];
  /** Jobs whose outcome (anything but OPEN) landed in the last 7 days; `empty` is an EMPTY outcome. Lane is null when no row names it. */
  finished?: { at: number; empty: boolean; lane: string | null }[];
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
  const settled = now - LAUNCH_SETTLE_MS;
  const launchedSince = settled - 7 * DAY;
  const series = metricsSeriesTally(now);
  const published = new Map<string, number>();
  const merged = new Map<string, number>();
  /** Same identity as the metrics series: the PR url when present, else the job. */
  const mergedPrs = new Map<string, number>();
  const launched = new Map<string, number>();
  const finished = new Map<string, { at: number; empty: boolean }>();
  const lanes = new Map<string, string>();
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
      const state = String([r.state, r.outcome, r.status, r.phase, r.result, r.conclusion].find(v => typeof v === 'string') ?? '').toUpperCase();
      const event = [r.event, r.type, r.kind].find((v): v is string => typeof v === 'string') ?? '';
      const lane = [r.lane, r.pool, r.arm].find((v): v is string => typeof v === 'string' && /^[\w.-]{1,40}$/.test(v));
      if (lane && (event === 'launch' || !lanes.has(job))) lanes.set(job, lane);
      if (event === 'outcome' && state && state !== 'OPEN') {
        const old = finished.get(job);
        if (!old || at < old.at) finished.set(job, { at, empty: state === 'EMPTY' });
      }
      if (event === 'launch') keepFirst(launched, job, at);
      else if (event === 'publish') keepFirst(published, job, at);
      else if (event === 'outcome' && state === 'MERGED') {
        keepFirst(merged, job, at);
        const url = [r.url, r.prUrl, r.pr_url, r.pr, r.html_url].find((v): v is string => typeof v === 'string');
        const m = typeof url === 'string' ? PR_URL.exec(url) : null;
        keepFirst(mergedPrs, m ? `${m[1]!.toLowerCase()}/pull/${m[2]}` : `job:${job}`, at);
      }
    },
    report(known: boolean): JobsFacts | null {
      if (!known) return null;
      const publishToMerge = [...merged].flatMap(([job, at]) => {
        const from = published.get(job);
        return at >= since7 && from !== undefined && from <= at ? [{ at, minutes: (at - from) / 60_000 }] : [];
      });
      const merges = [...mergedPrs.values()].filter(at => at >= since7).map(at => ({ at }));
      // A job's first launch is its launch; a retry under the same id is the same attempt at a PR.
      const launches = [...launched].filter(([, at]) => at >= launchedSince && at <= settled).map(([job, at]) => ({ at, merged: merged.has(job) }));
      const done = [...finished].filter(([, f]) => f.at >= since7).map(([job, f]) => ({ at: f.at, empty: f.empty, lane: lanes.get(job) ?? null }));
      return { series: series.report(true), latestAt, merges, publishToMerge, launches, finished: done };
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
  id: string; title: string; why: string; metric: string; unit: string;
  target: number | null; targetText: string; better: 'higher' | 'lower';
  current: number | null; currentText: string; updated_at: string | null; source: string; evidencePane: string;
  trend24h?: GoalTrend; trend7d?: GoalTrend; parts?: { name: string; value: number }[];
  status?: GoalStatus; reason?: string; ok: string; short: string;
}
/** Fill status from current against target; an explicit status (unknown/stale) wins. */
function goal(d: Draft): FleetGoal {
  const status: GoalStatus = d.status ?? (d.current === null || d.target === null ? 'unknown'
    : (d.better === 'higher' ? d.current >= d.target : d.current <= d.target) ? 'on-track' : 'behind');
  const reason = d.reason ?? (status === 'unknown' ? 'No reading yet.' : status === 'on-track' ? d.ok : d.short);
  const trend24h = d.trend24h ?? NO_TREND; const trend7d = d.trend7d ?? NO_TREND;
  return {
    id: d.id, title: d.title, why: d.why, metric: d.metric, unit: d.unit, target: d.target, targetText: d.targetText, better: d.better,
    current: d.current, currentText: d.current === null ? 'unknown' : d.currentText,
    trend: trend7d.direction !== 'unknown' ? trend7d.direction : trend24h.direction, trend24h, trend7d,
    updated_at: d.updated_at, source: d.source, status, statusText: statusText(status, reason), reason,
    parts: d.parts ?? [], evidencePane: d.evidencePane, next: null,
  };
}

/** The one-line end state for the top of the Goals views: counts only, no guessing about goals without a reading. */
export function goalsEndState(goals: readonly Pick<FleetGoal, 'status' | 'title'>[]): string {
  if (!goals.length) return 'No fleet goals yet.';
  const behind = goals.filter(g => g.status === 'behind');
  const known = goals.filter(g => g.status !== 'unknown').length;
  if (!known) return 'No goal has a reading yet, so where the fleet is heading is unknown.';
  const unknown = goals.length - known;
  const tail = unknown ? ` ${unknown} ${unknown === 1 ? 'has' : 'have'} no reading yet.` : '';
  if (!behind.length) return `On track on ${known === goals.length ? 'every goal' : `${known} of ${goals.length} goals`}.${tail}`;
  return `Behind on ${behind.length} of ${goals.length} goals: ${behind.slice(0, 3).map(g => g.title).join(', ')}${behind.length > 3 ? ` and ${behind.length - 3} more` : ''}.${tail}`;
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
  /** Next planned step by goal id; a goal with no entry has none linked. */
  nextSteps?: Readonly<Record<string, string>>;
  /** The leader vision file: text and last-write time; null when it could not be read. Omitted is the same as null. */
  vision?: { text: string; at: number | null } | null;
}

export function buildGoalScorecard(input: GoalScorecardInput): GoalScorecard {
  const { now, jobs, mains } = input;
  const T: GoalTargets = { ...DEFAULT_GOAL_TARGETS, ...input.targets };
  const goals: FleetGoal[] = [];
  const jobsAsOf = iso(jobs?.latestAt ?? null);
  const quiet = jobs !== null && jobs.latestAt === null;
  const noJobs = jobs === null ? 'The jobs ledger could not be read.' : quiet ? 'No jobs were recorded in the last 24 hours.' : undefined;
  const unknownIf = (cond: boolean) => (cond || noJobs ? { status: 'unknown' as const, reason: noJobs } : {});
  const hourly = <R extends { at: number }>(rows: readonly R[], value: (rows: R[]) => number | null) => jobs && !quiet ? buckets(rows, now, 24, HOUR, value) : [];
  const daily = <R extends { at: number }>(rows: readonly R[], value: (rows: R[]) => number | null) => jobs ? buckets(rows, now, 7, DAY, value) : [];

  const merges24 = jobs && !quiet ? jobs.series.mergesLast24h : null;
  goals.push(goal({
    id: 'merges-per-day', title: 'PRs merged per day', why: 'Merged PRs are the work that actually reaches the product.',
    metric: 'PRs merged in the last 24 hours', unit: 'PRs a day', target: T.mergesPerDay, targetText: `${T.mergesPerDay} or more a day`, better: 'higher',
    current: merges24, currentText: `${merges24} in the last 24 hours`, updated_at: jobsAsOf, source: 'metrics/jobs.jsonl',
    // Hourly points are per hour, so the target line is the daily target spread over 24 hours.
    trend24h: trend(jobs && !quiet ? jobs.series.hours.map(h => h.merged) : [], round(T.mergesPerDay / 24, 2)),
    // Days with no merge are a real zero once the ledger was read.
    trend7d: trend(daily(jobs?.merges ?? [], rows => rows.length).map(v => v ?? 0), T.mergesPerDay),
    evidencePane: 'fleet-metrics', ...unknownIf(false), ok: 'Merging at or above target.', short: 'Merging below target.',
  }));

  const ptm = jobs?.publishToMerge ?? [];
  const minutes = median(within(ptm, now, DAY).map(p => p.minutes));
  const medianOf = (rows: { minutes: number }[]) => round(median(rows.map(r => r.minutes))!);
  goals.push(goal({
    id: 'publish-to-merge', title: 'Time from PR opened to merged', why: 'A PR that waits goes stale, conflicts and blocks the work behind it.',
    metric: 'Median minutes from PR opened to merged, last 24 hours', unit: 'minutes',
    target: T.publishToMergeMinutes, targetText: `${T.publishToMergeMinutes} minutes or less`, better: 'lower',
    current: minutes === null ? null : round(minutes), currentText: `${minutes === null ? '' : round(minutes)} minutes`, updated_at: jobsAsOf, source: 'metrics/jobs.jsonl',
    trend24h: trend(hourly(ptm, medianOf), T.publishToMergeMinutes), trend7d: trend(daily(ptm, medianOf), T.publishToMergeMinutes), evidencePane: 'fleet-merges',
    ...unknownIf(minutes === null), ...(minutes === null && !noJobs ? { reason: 'No merged PR with a recorded open time in the last 24 hours.' } : {}),
    ok: 'PRs merge quickly after they open.', short: 'PRs wait too long to merge.',
  }));

  // Launches younger than a day may still merge; judging them would read as a false drop.
  const launches = jobs?.launches ?? [];
  const sharePct = (rows: { merged: boolean }[]) => round(rows.filter(r => r.merged).length / rows.length * 100);
  const launchShare = launches.length ? sharePct(launches) : null;
  goals.push(goal({
    id: 'launches-merged', title: 'Job launches that end in a merged PR', why: 'Every launch spends usage; a launch that merges nothing is spend with no result.',
    metric: 'Share of jobs launched 1 to 8 days ago that merged a PR', unit: '%',
    target: T.launchesMergedPercent, targetText: `${T.launchesMergedPercent}% or more`, better: 'higher',
    current: launchShare, currentText: `${launchShare}% of ${launches.length} launches`, updated_at: jobsAsOf, source: 'metrics/jobs.jsonl',
    trend7d: trend(jobs ? buckets(launches, now - LAUNCH_SETTLE_MS, 7, DAY, sharePct) : [], T.launchesMergedPercent),
    evidencePane: 'fleet-metrics',
    // A quiet last day does not erase a settled cohort, so only an unread ledger or an empty cohort is unknown.
    ...(jobs === null ? { status: 'unknown' as const, reason: 'The jobs ledger could not be read.' }
      : launchShare === null ? { status: 'unknown' as const, reason: 'No job was launched between 8 days and 1 day ago.' } : {}),
    ok: 'Most launches end in a merged PR.', short: 'Too many launches end without a merged PR.',
  }));

  // Share of finished jobs that ended EMPTY: zero finished jobs is unknown, never 0.
  const done24 = within(jobs?.finished ?? [], now, DAY);
  const emptyRate = (rows: { empty: boolean }[]) => round(rows.filter(r => r.empty).length / rows.length, 3);
  const wasted = done24.length ? emptyRate(done24) : null;
  const laneParts = [...new Set(done24.map(r => r.lane ?? 'lane not recorded'))].sort().map(name => {
    const rows = done24.filter(r => (r.lane ?? 'lane not recorded') === name);
    return { name, value: emptyRate(rows) };
  }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const pctText = (v: number) => `${round(v * 100)}%`;
  goals.push(goal({
    id: 'wasted-launch-rate', title: 'Jobs that finish empty', why: 'A job that ends EMPTY used a launch and changed nothing.',
    metric: 'Share of jobs finished in the last 24 hours that ended EMPTY', unit: 'share',
    target: T.wastedLaunchRate, targetText: `${pctText(T.wastedLaunchRate)} or less`, better: 'lower',
    current: wasted, currentText: `${pctText(wasted ?? 0)} of ${done24.length} finished jobs ended EMPTY`, updated_at: jobsAsOf, source: 'metrics/jobs.jsonl',
    trend24h: trend(hourly(jobs?.finished ?? [], emptyRate), T.wastedLaunchRate), trend7d: trend(daily(jobs?.finished ?? [], emptyRate), T.wastedLaunchRate),
    parts: laneParts, evidencePane: 'fleet-metrics',
    ...(jobs === null ? { status: 'unknown' as const, reason: 'The jobs ledger could not be read.' }
      : wasted === null ? { status: 'unknown' as const, reason: 'No job finished in the last 24 hours.' } : {}),
    ok: 'Few finished jobs end EMPTY.', short: 'Too many finished jobs end EMPTY.',
  }));

  const repos = mains?.source === 'ok' ? mains.repos : [];
  const green = repos.filter(r => r.state === 'green').length;
  const red = repos.filter(r => r.state === 'red');
  goals.push(goal({
    id: 'main-green', title: 'Default branches green', why: 'A red default branch blocks every merge into that repo.',
    metric: 'Repos whose default branch is green', unit: 'repos', target: repos.length || null, targetText: 'Every repo green', better: 'higher',
    current: repos.length ? green : null, currentText: `${green} of ${repos.length} repos green`, updated_at: mains?.statusAt ?? null, source: 'supervisor/status-main-guardian.md',
    evidencePane: 'fleet-mission',
    ...(!repos.length ? { status: 'unknown' as const, reason: 'The main guardian table could not be read.' }
      : mains!.stale ? { status: 'unknown' as const, reason: 'The main guardian table is stale.' }
      : red.length ? { status: 'behind' as const, reason: `Red: ${red.slice(0, 4).map(r => r.repo).join(', ')}${red.length > 4 ? ` and ${red.length - 4} more` : ''}.` }
      : green < repos.length ? { status: 'unknown' as const, reason: 'Some repos have no known state.' } : {}),
    ok: 'Every default branch is green.', short: 'Some default branches are red.',
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
    id: 'releases-7d', title: 'Releases in the last 7 days, per repo', why: 'Merged work only helps people once it ships in a release.',
    metric: 'Fewest releases any releasing repo shipped in the last 7 days', unit: 'releases',
    target: T.releasesPerRepoPer7d, targetText: `${plural(T.releasesPerRepoPer7d, 'release')} or more per repo`, better: 'higher',
    current: parts.length ? Math.min(...parts.map(p => p.value)) : null,
    currentText: `${plural(week.length, 'release')} across ${plural(parts.length, 'repo')}; fewest in one repo: ${parts[0]?.value ?? 0}`,
    updated_at: iso(last), source: 'metrics/growth-releases.jsonl', parts,
    trend24h: trend(input.releaseLines === null ? [] : buckets(releases, now, 24, HOUR, rows => rows.length).map(n => n ?? 0), null),
    trend7d: trend(input.releaseLines === null ? [] : buckets(releases, now, 7, DAY, rows => rows.length).map(n => n ?? 0), null),
    evidencePane: 'fleet-releases',
    ...(input.releaseLines === null ? { status: 'unknown' as const, reason: 'The release log could not be read.' }
      : !parts.length ? { status: 'unknown' as const, reason: 'No release is recorded.' }
      : short.length ? { status: 'behind' as const, reason: `Too few releases: ${short.slice(0, 4).map(p => `${p.name} (${p.value})`).join(', ')}${short.length > 4 ? ` and ${short.length - 4} more` : ''}.` } : {}),
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
      id, title: `${name} pool spent before it resets`, why: 'Included usage left at the reset is paid for and lost.',
      metric: `Share of the ${name} plan's included usage spent so far this period`, unit: '%',
      target: T.poolUsedByResetPercent, targetText: `${T.poolUsedByResetPercent}% or more used by reset`, better: 'higher',
      current: used, currentText: `${used}% used${left !== null && left > 0 ? `, resets in ${left < 48 ? `${round(left)} hours` : `${round(left / 24)} days`}` : ''}${projected === null ? '' : `, on pace for ${round(projected)}%`}`,
      updated_at: iso(at), source: 'queue/status.json', evidencePane: 'fleet-usage',
      ...(whyUnknown ? { status: 'unknown' as const, reason: whyUnknown }
        : { status: projected! >= T.poolUsedByResetPercent ? 'on-track' as const : 'behind' as const }),
      ok: 'On pace to use the pool before it resets.', short: 'On pace to leave part of the pool unused.',
    }));
  }
  const ordered = orderGoals(goals.map(g => ({ ...g, next: input.nextSteps?.[g.id]?.trim() || null })));
  const vision = input.vision ?? null;
  const bets = vision ? parseVisionBets(vision.text) : [];
  return {
    schema: 'fleet.goal-scorecard.v3', version: GOAL_SCORECARD_VERSION, generatedAt: new Date(now).toISOString(), malformedLines, targets: T, endState: goalsEndState(ordered), goals: ordered,
    end_state_text: vision ? visionEndState(vision.text) : null,
    bets, bets_source: vision ? VISION_SOURCE : null,
    bets_reason: !vision ? 'The leader vision file is missing or could not be read.' : bets.length ? null : 'The leader vision file lists no READY bets.',
    as_of: vision ? iso(vision.at) : null,
  };
}

export interface ReadGoalScorecardOptions {
  runsDir?: string; now?: () => number; targets?: Partial<GoalTargets>;
  /** The injectable readers: tests pass fixtures, production reads the runs dir. */
  readLines?: YieldLineReader;
  readStatus?: (path: string) => Promise<unknown>;
  /** Next planned step by goal id, when a caller has one linked. */
  nextSteps?: Readonly<Record<string, string>>;
  readMains?: (root: string, now: number) => Promise<FleetMainHealthV1 | null>;
  readReleaseLines?: (path: string) => Promise<readonly string[] | null>;
  /** Reads the vision file; null when missing or unreadable. */
  readVision?: (path: string) => Promise<{ text: string; at: number | null } | null>;
}

const readVisionFile = async (path: string): Promise<{ text: string; at: number | null } | null> => {
  const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path).catch(() => null)]);
  return { text, at: info ? info.mtimeMs : null };
};

const readStatusJson = (path: string): Promise<unknown> => readSource(path, 1024 * 1024, false)
  .then(s => s.state === 'healthy' ? JSON.parse(s.text) as unknown : null);

export async function readGoalScorecard(opts: ReadGoalScorecardOptions = {}): Promise<GoalScorecard> {
  const root = opts.runsDir ?? runsRoot();
  const now = (opts.now ?? Date.now)();
  const tally = jobsGoalTally(now);
  const [known, status, mains, releaseLines, vision] = await Promise.all([
    (opts.readLines ?? readLedgerLines)(join(root, 'metrics', 'jobs.jsonl'), line => tally.add(line)).catch(() => false),
    (opts.readStatus ?? readStatusJson)(join(root, 'queue', 'status.json')).catch(() => null),
    (opts.readMains ?? ((runsDir, at) => readFleetMainHealth({ runsDir, now: () => at })))(root, now).catch(() => null),
    (opts.readReleaseLines ?? readGrowthJsonl)(join(root, 'metrics', 'growth-releases.jsonl')).catch(() => null),
    (opts.readVision ?? readVisionFile)(join(root, VISION_SOURCE)).catch(() => null),
  ]);
  return buildGoalScorecard({ now, jobs: tally.report(known), status, mains, releaseLines, vision, ...(opts.targets ? { targets: opts.targets } : {}), ...(opts.nextSteps ? { nextSteps: opts.nextSteps } : {}) });
}

const TREND_WORDS: Record<TrendDirection, string> = { up: 'rising', down: 'falling', flat: 'steady', unknown: 'no trend yet' };

/** Plain text for people: one block per goal, behind first. */
export function renderGoalScorecard(card: GoalScorecard): string {
  if (!card.goals.length) return 'No goals yet.';
  const lines = [...(card.end_state_text ? [`Vision: ${card.end_state_text}`] : []), card.endState, ...card.goals.flatMap(g => [
    `${g.title}: ${g.statusText}`,
    `  Now ${g.currentText} ${TREND_MARK[g.trend]} · target ${g.targetText} · 24 h ${TREND_WORDS[g.trend24h.direction]} · 7 d ${TREND_WORDS[g.trend7d.direction]}`,
    `  Why it matters: ${g.why}`,
    ...(g.status === 'unknown' ? [] : [`  ${g.reason}`]),
    ...(g.next ? [`  Next: ${g.next}`] : []),
    `  As of ${g.updated_at ?? 'unknown'} from ${g.source}.`,
  ])];
  if (card.bets?.length) lines.push('Current bets:', ...card.bets.map(b => `  ${b.id}${b.pool ? ` (${b.pool}${b.repo ? `, ${b.repo}` : ''})` : ''}: ${b.goal}`));
  else if (card.bets_reason) lines.push(`Current bets: none. ${card.bets_reason}`);
  if (card.malformedLines) lines.push(`${card.malformedLines} unreadable metrics line${card.malformedLines === 1 ? ' was' : 's were'} skipped.`);
  return lines.join('\n');
}
