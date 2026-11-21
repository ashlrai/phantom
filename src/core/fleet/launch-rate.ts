/**
 * `phm fleet launches`: how many jobs start per hour and which lanes those starts go to (RQ-LAUNCHRATEN19QQ8).
 *
 * The fleet's ceiling is often the start rate, not the number of lanes: a dispatcher that starts two jobs a
 * tick, taking lanes in turn, hands half its starts to a lane that never merges while a lane with plan to spare
 * waits. `buildLaunchRate` reads the job metrics file (the same launch, finish, publish and outcome rows that
 * `phm throughput` reads, with the same merged rule) and the router's plan readings (`phm fleet resources`), and
 * returns starts per hour, the longest gap between starts, starts and merged per start by lane, wasted starts and
 * a short plain-words list of what to change. Pure; anything not measured is null or "unknown", never zero.
 */
import { readFleetResourcesView } from '../../cli/fleet-resources.js';
import { ledgerRows, readText } from './empty-cause.js';
import { buildRelaunches, type JobRelaunches, type RelaunchJob } from './relaunches.js';

export const LAUNCH_RATE_SCHEMA = 'fleet.launches.v1';
export const LAUNCH_RATE_MAX_HOURS = 168;
/** A lane whose merged per start over the last 24 hours is under this is wasting its starts... */
export const WASTE_RATE = 0.1;
/** ...once it has at least this many starts in those 24 hours. */
export const WASTE_MIN_STARTS = 10;
/** A gap between starts earns its own recommendation when it is this long or longer... */
export const GAP_NOTE_MINUTES = 30;
/** ...and at least this many times the window's average spacing, so an even, slow spread is not called out. */
export const GAP_NOTE_SPACING = 3;
/** Plan use under this, on a lane that merges, is room for more starts. */
const SPARE_USED_FRAC = 0.5;
const HOUR = 3_600_000;
/** Launch rows this far back still name the lane of a PR that merges inside the window. */
const ROUTE_LOOKBACK_HOURS = 72;
const LEDGER_TAIL_BYTES = 32 * 1024 * 1024;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;

/** One lane's plan reading from the router, as `phm fleet resources` reports it. */
export interface LanePlan { lane: string; usedFrac: number | null; resetAt: string | null }

export interface LaunchLane {
  lane: string;
  /** Starts inside the window. */
  starts: number;
  /** PRs from this lane's jobs merged inside the window. */
  merged: number;
  merged_per_start: number | null;
  starts_24h: number;
  merged_24h: number;
  merged_per_start_24h: number | null;
  /** 24-hour starts for each merged PR (starts_24h / merged_24h); null when nothing merged. */
  starts_per_merged_pr: number | null;
  /** 24-hour merged per start under the threshold with at least the minimum starts. */
  wasted: boolean;
  /** Plan use 0..1+ from the router; null when unknown. */
  used_frac: number | null;
  /** Hours to the plan reset; null when unknown or already passed. */
  reset_hours: number | null;
}

export interface LaunchGap { from: string; to: string; minutes: number }

export interface LaunchRateReport {
  schema: typeof LAUNCH_RATE_SCHEMA;
  as_of: string;
  hours: number;
  metrics: 'ok' | 'unreadable';
  /** 'unknown' when no plan reading could be read. */
  plans: 'ok' | 'unknown';
  waste_rule: { merged_per_start_under: number; min_starts_24h: number };
  starts: number | null;
  starts_per_hour: number | null;
  /** Longest stretch with no start, counting the window's start and now as edges. */
  longest_gap: LaunchGap | null;
  /** Starts in the window that went to wasted lanes. */
  wasted_starts: number | null;
  lanes: LaunchLane[];
  /** Per job id over the last 24 h: launches, lanes, minutes spent, PRs and merged (see relaunches.ts). */
  relaunches: Record<string, JobRelaunches>;
  /** Jobs with 3 or more launches in 24 h and no merged PR, worst first, in plain words. */
  repeat_jobs: RelaunchJob[];
  headline: string;
  /** Plain-words changes, most important first. Never empty. */
  recommendations: string[];
}

export interface LaunchRateInput {
  ledger: string | null;
  now: number;
  hours: number;
  /** null when the plan readings could not be read. */
  plans?: readonly LanePlan[] | null;
  threshold?: number;
  minStarts?: number;
}

const label = (value: unknown): string | null => typeof value === 'string' && /^[\w][\w.:@/-]{0,79}$/.test(value.trim()) ? value.trim() : null;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const rate = (merged: number, starts: number): number | null => starts > 0 ? merged / starts : null;

/** Pure: validate `--hours` / `?hours=` (whole hours, 1 to 168, default 24). Null when invalid. */
export function launchRateHours(value?: string | null): number | null {
  const hours = value == null ? 24 : /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  return hours >= 1 && hours <= LAUNCH_RATE_MAX_HOURS ? hours : null;
}

/** Plain duration: "45 m", "2 h", "2 h 10 m". */
export function gapText(minutes: number): string {
  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60), m = whole % 60;
  return h === 0 ? `${m} m` : m === 0 ? `${h} h` : `${h} h ${m} m`;
}

const clock = (iso: string): string => `${iso.slice(11, 16)} UTC`;

function planText(lane: LaunchLane): string {
  const used = lane.used_frac === null ? 'use unknown' : `${Math.round(lane.used_frac * 100)}% used`;
  const left = lane.reset_hours === null ? 'reset unknown' : `${Math.round(lane.reset_hours)} h left`;
  return `${used}, ${left}`;
}

/** Pure: one start per launch row, one merge per PR (earliest time), each tied to its job's lane. */
function events(ledger: string, now: number, lookbackHours: number) {
  const { rows } = ledgerRows(ledger, now, lookbackHours, true);
  const laneOf = new Map<string, string>();
  const jobOfPr = new Map<string, string>();
  const starts: { job: string; at: number; lane: string | null }[] = [];
  const merges = new Map<string, { job: string; at: number; lane: string | null }>();
  for (const { row, id, at } of rows) {
    const event = [row.event, row.type, row.kind].find((v): v is string => typeof v === 'string') ?? (row.source === 'metrics-outcomes-reconciler' ? 'outcome' : null);
    const lane = label(row.lane) ?? label(row.pool) ?? label(row.arm);
    // The launch row decides a job's lane; other rows only fill a gap.
    if (id && lane && (event === 'launch' || !laneOf.has(id))) laneOf.set(id, lane);
    if (event === 'launch' && id) { starts.push({ job: id, at, lane }); continue; }
    const url = PR_URL.exec(String([row.url, row.prUrl, row.pr_url, row.pr, row.html_url].find((v): v is string => typeof v === 'string') ?? ''));
    const key = url ? `${url[1]}#${url[2]}`.toLowerCase() : id ? `job:${id}` : null;
    if ((event === 'publish' || event === 'published') && url && id) { jobOfPr.set(key!, id); continue; }
    const merged = event === 'merged' || (event === 'outcome' && (row.state ?? row.outcome ?? row.status ?? row.phase ?? row.result ?? row.conclusion) === 'MERGED');
    if (!merged || key === null) continue;
    const stamp = typeof row.mergedAt === 'string' ? Date.parse(row.mergedAt) : NaN;
    const when = Number.isFinite(stamp) && stamp <= now ? stamp : at;
    const seen = merges.get(key);
    // Re-emitted outcome rows for one PR count once, at their earliest time.
    if (!seen || when < seen.at) merges.set(key, { job: seen?.job || id, at: when, lane: seen?.lane ?? lane });
  }
  for (const [key, merge] of merges) merge.job ||= jobOfPr.get(key) ?? '';
  const laneFor = (job: string, own: string | null): string => (job ? laneOf.get(job) : undefined) ?? own ?? 'unknown';
  return {
    starts: starts.map(start => ({ at: start.at, lane: laneFor(start.job, start.lane) })),
    merges: [...merges.values()].map(merge => ({ at: merge.at, lane: laneFor(merge.job, merge.lane) })),
  };
}

/** Pure: the start-rate report for one window. */
export function buildLaunchRate(input: LaunchRateInput): LaunchRateReport {
  const { now, hours } = input;
  const threshold = input.threshold ?? WASTE_RATE, minStarts = input.minStarts ?? WASTE_MIN_STARTS;
  const since = now - hours * HOUR, daySince = now - 24 * HOUR;
  const plans = input.plans ?? null;
  const report: LaunchRateReport = {
    schema: LAUNCH_RATE_SCHEMA, as_of: new Date(now).toISOString(), hours,
    metrics: input.ledger === null ? 'unreadable' : 'ok', plans: plans === null || plans.length === 0 ? 'unknown' : 'ok',
    waste_rule: { merged_per_start_under: threshold, min_starts_24h: minStarts },
    starts: null, starts_per_hour: null, longest_gap: null, wasted_starts: null, lanes: [], relaunches: {}, repeat_jobs: [], headline: '', recommendations: [],
  };
  if (input.ledger === null) {
    report.headline = `Starts in the last ${hours} h: unknown (cannot read the job metrics file)`;
    report.recommendations = ['Job metrics could not be read, so starts and merges are unknown.'];
    return report;
  }
  const { starts, merges } = events(input.ledger, now, Math.max(hours, 24) + ROUTE_LOOKBACK_HOURS);
  const lanes = new Map<string, LaunchLane>();
  const lane = (name: string): LaunchLane => {
    let entry = lanes.get(name);
    if (!entry) {
      entry = { lane: name, starts: 0, merged: 0, merged_per_start: null, starts_24h: 0, merged_24h: 0, merged_per_start_24h: null, starts_per_merged_pr: null, wasted: false, used_frac: null, reset_hours: null };
      lanes.set(name, entry);
    }
    return entry;
  };
  const inWindow: number[] = [];
  for (const start of starts) {
    if (start.at >= since) { lane(start.lane).starts++; inWindow.push(start.at); }
    if (start.at >= daySince) lane(start.lane).starts_24h++;
  }
  for (const merge of merges) {
    if (merge.at >= since) lane(merge.lane).merged++;
    if (merge.at >= daySince) lane(merge.lane).merged_24h++;
  }
  for (const plan of plans ?? []) {
    const entry = lanes.get(plan.lane);
    if (!entry) continue;
    entry.used_frac = plan.usedFrac;
    const reset = plan.resetAt === null ? NaN : Date.parse(plan.resetAt);
    entry.reset_hours = Number.isFinite(reset) && reset > now ? round1((reset - now) / HOUR) : null;
  }
  let wasted = 0;
  for (const entry of lanes.values()) {
    entry.merged_per_start = rate(entry.merged, entry.starts);
    entry.merged_per_start_24h = rate(entry.merged_24h, entry.starts_24h);
    entry.starts_per_merged_pr = rate(entry.starts_24h, entry.merged_24h);
    entry.wasted = entry.starts_24h >= minStarts && entry.merged_24h / entry.starts_24h < threshold;
    if (entry.wasted) wasted += entry.starts;
  }
  const relaunches = buildRelaunches(input.ledger, now);
  report.relaunches = relaunches.jobs;
  report.repeat_jobs = relaunches.repeat_jobs;
  inWindow.sort((a, b) => a - b);
  const edges = [since, ...inWindow, now];
  for (let i = 1; i < edges.length; i++) {
    const minutes = (edges[i]! - edges[i - 1]!) / 60_000;
    if (!report.longest_gap || minutes > report.longest_gap.minutes) {
      report.longest_gap = { from: new Date(edges[i - 1]!).toISOString(), to: new Date(edges[i]!).toISOString(), minutes: round1(minutes) };
    }
  }
  report.starts = inWindow.length;
  report.starts_per_hour = round1(inWindow.length / hours);
  report.wasted_starts = wasted;
  report.lanes = [...lanes.values()].sort((a, b) => b.starts - a.starts || b.starts_24h - a.starts_24h || a.lane.localeCompare(b.lane));
  report.headline = `${inWindow.length} starts in the last ${hours} h (${report.starts_per_hour} an hour), ${wasted} wasted, longest gap ${gapText(report.longest_gap!.minutes)}`;
  report.recommendations = recommend(report);
  return report;
}

/** Pure: what to change, in plain words, most important first. */
function recommend(report: LaunchRateReport): string[] {
  const lines: string[] = [];
  const total24 = report.lanes.reduce((sum, entry) => sum + entry.starts_24h, 0);
  // Somewhere for a wasted lane's rows to go: a lane that merged, with plan left, least used first.
  const targets = report.lanes
    .filter(entry => !entry.wasted && entry.merged_24h > 0 && (entry.used_frac === null || entry.used_frac < 1))
    .sort((a, b) => (a.used_frac ?? 2) - (b.used_frac ?? 2) || (b.merged_per_start_24h ?? 0) - (a.merged_per_start_24h ?? 0) || a.lane.localeCompare(b.lane));
  const target = targets[0];
  const wasted = report.lanes.filter(entry => entry.wasted).sort((a, b) => b.starts_24h - a.starts_24h);
  for (const entry of wasted) {
    lines.push(`${entry.lane} took ${entry.starts_24h} of ${total24} starts in 24 h and merged ${entry.merged_24h}; ${target
      ? `send its rows to ${target.lane} (${planText(target)})` : 'hold its rows until another lane merges'}.`);
  }
  const gap = report.longest_gap;
  if (report.starts === 0) lines.push(`No job started in the last ${report.hours} h; check that the dispatcher is running.`);
  else if (gap && gap.minutes >= Math.max(GAP_NOTE_MINUTES, GAP_NOTE_SPACING * report.hours * 60 / report.starts!)) lines.push(`No job started for ${gapText(gap.minutes)} (${clock(gap.from)} to ${clock(gap.to)}); check the dispatcher for that stretch.`);
  // A lane that merges with plan to spare but a below-even share of starts can take more, unless it is already the target above.
  const active = report.lanes.filter(entry => entry.starts > 0).length || 1;
  for (const entry of report.starts ? report.lanes : []) {
    if (wasted.length && entry === target) continue;
    if (entry.wasted || entry.merged_24h === 0 || entry.used_frac === null || entry.used_frac >= SPARE_USED_FRAC) continue;
    if (entry.starts / report.starts! >= 1 / active) continue;
    lines.push(`${entry.lane} merges and has plan to spare (${planText(entry)}) but took ${entry.starts} of ${report.starts} starts; give it more.`);
  }
  if (!lines.length) lines.push(`Nothing to change: no lane with ${report.waste_rule.min_starts_24h} or more starts in 24 h merged under ${report.waste_rule.merged_per_start_under} per start.`);
  return lines;
}

/** Plain lines for the CLI: headline, recommendations, then one row per lane. */
export function launchRateText(report: LaunchRateReport): string[] {
  const shown = (value: number | null): string => value === null ? 'unknown' : String(Math.round(value * 100) / 100);
  return [
    `${report.headline}.`,
    ...report.recommendations.map(line => `- ${line}`),
    ...(report.lanes.length ? ['By lane (window, then 24 h):'] : []),
    ...report.lanes.map(entry => `  ${entry.lane}: ${entry.starts} starts, ${entry.merged} merged (${shown(entry.merged_per_start)} per start); 24 h ${entry.starts_24h} starts, ${entry.merged_24h} merged (${shown(entry.merged_per_start_24h)} per start)${entry.wasted ? ', WASTED' : ''}; plan ${planText(entry)}`),
  ];
}

/** Read the job metrics file and the router's plan readings. Read-only; never throws. */
export async function readLaunchRate(opts: { runsDir: string; metricsPath: string; hours: number; now: number; read?: (path: string) => Promise<string> }): Promise<LaunchRateReport> {
  const [ledger, plans] = await Promise.all([
    readText(opts.metricsPath, LEDGER_TAIL_BYTES),
    readFleetResourcesView(opts.read, opts.runsDir, new Date(opts.now))
      .then(view => view.resources === 'healthy' ? view.lanes.map(entry => ({ lane: entry.lane, usedFrac: entry.usedFrac, resetAt: entry.resetAt })) : null)
      .catch(() => null),
  ]);
  return buildLaunchRate({ ledger, now: opts.now, hours: opts.hours, plans });
}
