/**
 * core/fleet/goal-scorecard.ts: the fleet's standing goals (RQ-GOALSVIEWN17EQ8).
 * One row per goal with a target, the current value, when and where it was
 * read, a 24-hour trend and a status. Shared by `phm goals` and the desktop
 * Goals view (`GET /api/verse/fleet/runs/goal-scorecard`), so both agree.
 *
 * Every number comes from a file Phantom already writes under the runs dir:
 * metrics/jobs.jsonl (merges, publish-to-merge, empty finishes),
 * queue/status.json `budget` (usage pools), the main guardian table and
 * metrics/growth-releases.jsonl (releases). Read-only. A missing, unreadable
 * or stale signal is `unknown`, never zero.
 */
import { join } from 'node:path';
import { readGrowthJsonl } from '../growth/read.js';
import { runsRoot } from '../metrics/loop-collect.js';
import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { readFleetMainHealth, type FleetMainHealthV1 } from './main-health.js';
import { metricsSeriesTally, type FleetMetricsSeries } from './metrics-series.js';
import { readSource } from './runs-parked-queue.js';

const HOUR = 3_600_000;
/** Targets in one place. Pools follow the Nov 5, 2026 no-reserve order: spend the pool before it resets. */
export const GOAL_TARGETS = {
  mergesPerHour: 4,
  publishToMergeMinutes: 60,
  emptyFinishRate: 0.2,
  mainGreenPercent: 100,
  /** Same bar as the Releases pane's "release train is behind" line. */
  hoursBetweenReleases: 2,
  poolUsedByResetPercent: 90,
} as const;
/** A pool reading older than this no longer says how the pool is doing. */
export const POOL_READING_STALE_MS = 6 * HOUR;

export type GoalStatus = 'on-track' | 'behind' | 'unknown';
export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';
export interface FleetGoal {
  /** Stable across runs; pools are `pool-<name>`. */
  id: string;
  title: string;
  target: string;
  value: number | null;
  /** Plain words; "unknown" when value is null. */
  valueText: string;
  asOf: string | null;
  /** File under the runs dir the value came from. */
  source: string;
  /** 24 hourly points, oldest first; null is an hour without data. Empty when the source keeps no history. */
  trend: { points: (number | null)[]; direction: TrendDirection };
  status: GoalStatus;
  /** One plain sentence: why this status. */
  why: string;
  /** Desktop pane that shows the underlying evidence. */
  evidencePane: string;
}
export interface GoalScorecard {
  schema: 'fleet.goal-scorecard.v1';
  generatedAt: string;
  /** Lines in metrics/jobs.jsonl or growth-releases.jsonl that could not be read; they are skipped. */
  malformedLines: number;
  goals: FleetGoal[];
}

/** What one pass over metrics/jobs.jsonl learned. Null fields mean the ledger was not read. */
export interface JobsFacts {
  series: FleetMetricsSeries;
  /** Newest valid row time, ms; null when no row fell in the last 24 hours. */
  latestAt: number | null;
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

/** Streaming tally over jobs.jsonl lines; merges and malformed counts reuse the metrics series. */
export function jobsGoalTally(now: number) {
  const since = now - 24 * HOUR;
  const series = metricsSeriesTally(now);
  const published = new Map<string, number>();
  const merged = new Map<string, number>();
  const finishes = new Map<string, { at: number; empty: boolean }>();
  let latestAt: number | null = null;
  return {
    add(line: string): void {
      series.add(line);
      let r: Record<string, unknown>;
      try { r = rec(JSON.parse(line)); } catch { return; } // counted by the series tally
      const at = time(r.ts ?? r.at);
      const job = r.job ?? r.jobId ?? r.job_id ?? r.id;
      if (at === null || at > now) return;
      if (at >= since) latestAt = Math.max(latestAt ?? at, at);
      if (typeof job !== 'string' || !job) return;
      const keepFirst = (map: Map<string, number>) => { if (!map.has(job) || at < map.get(job)!) map.set(job, at); };
      const state = String(r.state ?? r.outcome ?? r.status ?? '').toUpperCase();
      if (r.event === 'publish') keepFirst(published);
      else if (r.event === 'outcome' && state === 'MERGED') keepFirst(merged);
      else if (r.event === 'finish' && at >= since) finishes.set(`${job}\n${at}`, { at, empty: r.empty === true });
    },
    report(known: boolean): JobsFacts | null {
      if (!known) return null;
      const publishToMerge = [...merged].flatMap(([job, at]) => {
        const from = published.get(job);
        return at >= since && from !== undefined && from <= at ? [{ at, minutes: (at - from) / 60_000 }] : [];
      });
      return { series: series.report(true), latestAt, publishToMerge, finishes: [...finishes.values()] };
    },
  };
}

function hourly<T>(rows: readonly (T & { at: number })[], now: number, value: (rows: T[]) => number | null): (number | null)[] {
  const since = now - 24 * HOUR;
  const buckets: T[][] = Array.from({ length: 24 }, () => []);
  for (const row of rows) if (row.at >= since && row.at <= now) buckets[Math.min(23, Math.floor((row.at - since) / HOUR))]!.push(row);
  return buckets.map(b => b.length ? value(b) : null);
}

/** Earlier 12 hours against the later 12: a 10% relative change is a direction. */
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

type Draft = Omit<FleetGoal, 'trend' | 'status' | 'why'> & { points: (number | null)[]; status?: GoalStatus; why?: string };
/** Fill status from value against target; an explicit status (unknown/stale) wins. */
function goal(d: Draft, better: 'higher' | 'lower', bar: number, ok: string, short: string): FleetGoal {
  const status: GoalStatus = d.status ?? (d.value === null ? 'unknown' : (better === 'higher' ? d.value >= bar : d.value <= bar) ? 'on-track' : 'behind');
  const why = d.why ?? (status === 'unknown' ? 'No reading yet.' : status === 'on-track' ? ok : short);
  return {
    id: d.id, title: d.title, target: d.target, value: d.value, valueText: d.value === null ? 'unknown' : d.valueText,
    asOf: d.asOf, source: d.source, trend: { points: d.points, direction: trendDirection(d.points) }, status, why, evidencePane: d.evidencePane,
  };
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
}

export function buildGoalScorecard(input: GoalScorecardInput): GoalScorecard {
  const { now, jobs, mains } = input;
  const T = GOAL_TARGETS;
  const goals: FleetGoal[] = [];
  const jobsAsOf = iso(jobs?.latestAt ?? null);
  const quiet = jobs !== null && jobs.latestAt === null;
  const noJobs = jobs === null ? 'The jobs ledger could not be read.' : quiet ? 'No jobs were recorded in the last 24 hours.' : undefined;
  const unknownIf = (cond: boolean) => (cond || noJobs ? { status: 'unknown' as const, why: noJobs } : {});

  const merges24 = jobs && !quiet ? jobs.series.mergesLast24h : null;
  const perHour = merges24 === null ? null : round(merges24 / 24, 2);
  goals.push(goal({
    id: 'merges-per-hour', title: 'PRs merged per hour', target: `${T.mergesPerHour} or more an hour`,
    value: perHour, valueText: `${perHour} an hour (${merges24} in 24 h)`, asOf: jobsAsOf, source: 'metrics/jobs.jsonl',
    points: jobs && !quiet ? jobs.series.hours.map(h => h.merged) : [], evidencePane: 'fleet-metrics', ...unknownIf(false),
  }, 'higher', T.mergesPerHour, 'Merging at or above target.', 'Merging below target.'));

  const minutes = jobs ? median(jobs.publishToMerge.map(p => p.minutes)) : null;
  goals.push(goal({
    id: 'publish-to-merge', title: 'Median time from publish to merge', target: `${T.publishToMergeMinutes} minutes or less`,
    value: minutes === null ? null : round(minutes), valueText: `${minutes === null ? '' : round(minutes)} minutes`, asOf: jobsAsOf, source: 'metrics/jobs.jsonl',
    points: jobs && !quiet ? hourly(jobs.publishToMerge, now, rows => round(median(rows.map(r => r.minutes))!)) : [], evidencePane: 'fleet-merges',
    ...unknownIf(minutes === null), ...(minutes === null && !noJobs ? { why: 'No merged PR with a recorded publish time in the last 24 hours.' } : {}),
  }, 'lower', T.publishToMergeMinutes, 'PRs merge quickly after publish.', 'PRs wait too long to merge.'));

  const finished = jobs?.finishes ?? [];
  const emptyRate = finished.length ? finished.filter(f => f.empty).length / finished.length : null;
  goals.push(goal({
    id: 'empty-finish-rate', title: 'Jobs that finish with no change', target: `${T.emptyFinishRate * 100}% or less`,
    value: emptyRate === null ? null : round(emptyRate, 3), valueText: `${emptyRate === null ? '' : round(emptyRate * 100)}% of ${finished.length} finishes`,
    asOf: jobsAsOf, source: 'metrics/jobs.jsonl', points: noJobs ? [] : hourly(finished, now, rows => round(rows.filter(r => r.empty).length / rows.length, 3)),
    evidencePane: 'fleet-metrics', ...unknownIf(emptyRate === null), ...(emptyRate === null && !noJobs ? { why: 'No job finished in the last 24 hours.' } : {}),
  }, 'lower', T.emptyFinishRate, 'Few jobs finish empty.', 'Too many jobs finish empty.'));

  const repos = mains?.source === 'ok' ? mains.repos : [];
  const green = repos.filter(r => r.state === 'green').length;
  const red = repos.filter(r => r.state === 'red');
  const greenPct = repos.length ? round(green / repos.length * 100) : null;
  goals.push(goal({
    id: 'main-green', title: 'Main branch green in every repo', target: 'All repos green',
    value: greenPct, valueText: `${green} of ${repos.length} green`, asOf: mains?.statusAt ?? null, source: 'supervisor/status-main-guardian.md',
    points: [], evidencePane: 'fleet-mission',
    ...(!repos.length ? { status: 'unknown' as const, why: 'The main guardian table could not be read.' }
      : mains!.stale ? { status: 'unknown' as const, why: 'The main guardian table is stale.' }
      : red.length ? { status: 'behind' as const, why: `Red: ${red.slice(0, 4).map(r => r.repo).join(', ')}${red.length > 4 ? ` and ${red.length - 4} more` : ''}.` }
      : green < repos.length ? { status: 'unknown' as const, why: 'Some repos have no known state.' } : {}),
  }, 'higher', T.mainGreenPercent, 'Every main branch is green.', 'Some main branches are red.'));

  let malformedLines = jobs?.series.malformedLines ?? 0;
  const releases: number[] = [];
  for (const line of input.releaseLines ?? []) {
    if (!line.trim()) continue;
    let at: number | null = null;
    try { at = time(rec(JSON.parse(line)).publishedAt); } catch { /* counted below */ }
    if (at === null) malformedLines++; else if (at <= now) releases.push(at);
  }
  const last = releases.length ? Math.max(...releases) : null;
  const sinceRelease = last === null ? null : round((now - last) / HOUR);
  goals.push(goal({
    id: 'release-cadence', title: 'Time since the last release', target: `A release every ${T.hoursBetweenReleases} hours or sooner`,
    value: sinceRelease, valueText: `${sinceRelease} hours ago`, asOf: iso(last), source: 'metrics/growth-releases.jsonl',
    points: input.releaseLines === null ? [] : hourly(releases.map(at => ({ at })), now, rows => rows.length).map(n => n ?? 0),
    evidencePane: 'fleet-releases',
    ...(input.releaseLines === null ? { why: 'The release log could not be read.' } : last === null ? { why: 'No release is recorded.' } : {}),
  }, 'lower', T.hoursBetweenReleases, 'Releases are shipping on time.', 'The release train is behind.'));

  const status = rec(input.status);
  const statusAt = time(status.last_tick);
  for (const [name, raw] of Object.entries(rec(status.budget)).sort(([a], [b]) => a.localeCompare(b))) {
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
      value: used, valueText: `${used}% used${left !== null && left > 0 ? `, resets in ${left < 48 ? `${round(left)} hours` : `${round(left / 24)} days`}` : ''}${projected === null ? '' : `, on pace for ${round(projected)}%`}`,
      asOf: iso(at), source: 'queue/status.json', points: [], evidencePane: 'fleet-usage',
      ...(whyUnknown ? { status: 'unknown' as const, why: whyUnknown }
        : { status: projected! >= T.poolUsedByResetPercent ? 'on-track' as const : 'behind' as const }),
    }, 'higher', T.poolUsedByResetPercent, 'On pace to use the pool before it resets.', 'On pace to leave part of the pool unused.'));
  }
  return { schema: 'fleet.goal-scorecard.v1', generatedAt: new Date(now).toISOString(), malformedLines, goals };
}

export interface ReadGoalScorecardOptions { runsDir?: string; now?: () => number; readLines?: YieldLineReader }

export async function readGoalScorecard(opts: ReadGoalScorecardOptions = {}): Promise<GoalScorecard> {
  const root = opts.runsDir ?? runsRoot();
  const now = (opts.now ?? Date.now)();
  const tally = jobsGoalTally(now);
  const [known, status, mains, releaseLines] = await Promise.all([
    (opts.readLines ?? readLedgerLines)(join(root, 'metrics', 'jobs.jsonl'), line => tally.add(line)).catch(() => false),
    readSource(join(root, 'queue', 'status.json'), 1024 * 1024, false)
      .then(s => s.state === 'healthy' ? JSON.parse(s.text) as unknown : null).catch(() => null),
    readFleetMainHealth({ runsDir: root, now: () => now }).catch(() => null),
    readGrowthJsonl(join(root, 'metrics', 'growth-releases.jsonl')).catch(() => null),
  ]);
  return buildGoalScorecard({ now, jobs: tally.report(known), status, mains, releaseLines });
}

const STATUS_WORDS: Record<GoalStatus, string> = { 'on-track': 'on track', behind: 'behind', unknown: 'unknown' };
const ARROWS: Record<TrendDirection, string> = { up: 'rising', down: 'falling', flat: 'steady', unknown: 'no trend yet' };

/** Plain text for people: one block per goal. */
export function renderGoalScorecard(card: GoalScorecard): string {
  if (!card.goals.length) return 'No goals yet.';
  const lines = card.goals.flatMap(g => [
    `${g.title}: ${STATUS_WORDS[g.status]}`,
    `  Now ${g.valueText} · target ${g.target} · 24 h ${ARROWS[g.trend.direction]}`,
    `  ${g.why} As of ${g.asOf ?? 'unknown'} from ${g.source}.`,
  ]);
  if (card.malformedLines) lines.push(`${card.malformedLines} unreadable metrics line${card.malformedLines === 1 ? ' was' : 's were'} skipped.`);
  return lines.join('\n');
}
