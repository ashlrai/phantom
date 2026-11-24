/**
 * Which finished job folders are safe to remove, and what that buys. Pure and browser-safe:
 * records in, a report out. It never touches the disk; `phm disk --plan` only prints it.
 *
 * A folder is in the plan only when every fact is known and says "finished, nothing to lose":
 * result merged, closed or empty; no uncommitted changes; zero commits ahead; not running;
 * older than the age limit. Any unknown field puts it under `notSure` instead.
 */
import type { HostDiskTrend } from '../fleet/host-top-view.js';

export const DISK_PLAN_SCHEMA = 'disk.plan.v1';
export const DISK_PLAN_MIN_AGE_HOURS = 6;
const GB = 1e9;
const HOUR_MS = 3_600_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export const WORKTREE_RESULTS = ['pr-open', 'pr-merged', 'pr-closed', 'empty', 'publish-aborted', 'running', 'unknown'] as const;
export type WorktreeResult = (typeof WORKTREE_RESULTS)[number];

export interface WorktreeRecord {
  jobId: string;
  /** Null when the size could not be measured. */
  bytes: number | null;
  /** Epoch ms of the last change, null when unknown. */
  modifiedMs: number | null;
  result: WorktreeResult;
  uncommitted: 'yes' | 'no' | 'unknown';
  /** Commits ahead of the base branch, null when unknown. */
  commitsAhead: number | null;
}

export interface PlanFolder { jobId: string; gb: number | null; result: WorktreeResult }
export interface PlanKept extends PlanFolder { reason: string }

export interface RemovalPlanReport {
  schema: typeof DISK_PLAN_SCHEMA;
  minAgeHours: number;
  folders: number;
  /** GB per result class; folders with an unknown size add nothing here. */
  gbByResult: Record<WorktreeResult, number>;
  /** How many folders each class holds, whatever their size. */
  countByResult: Record<WorktreeResult, number>;
  /** The ten largest folders with a known size. */
  largest: PlanFolder[];
  /** Safe by rule. Listing here is a suggestion only: this change removes nothing. */
  plan: { folders: PlanFolder[]; count: number; gb: number };
  /** An unknown field stopped these; they stay. */
  notSure: PlanKept[];
  /** Publish aborted after a push: the work may exist nowhere else. Recover first. */
  unpublished: PlanFolder[];
  /** Known and not safe: open, running, uncommitted, commits ahead or too new. */
  kept: PlanKept[];
}

const gbOf = (bytes: number | null): number | null => (bytes === null ? null : round1(bytes / GB));

/** Why a record is not safe yet, from its unknown fields; empty when every field is known. */
function unknownFields(r: WorktreeRecord): string[] {
  const missing: string[] = [];
  if (r.result === 'unknown') missing.push('result');
  if (r.bytes === null) missing.push('size');
  if (r.modifiedMs === null) missing.push('last-modified time');
  if (r.uncommitted === 'unknown') missing.push('uncommitted changes');
  if (r.commitsAhead === null) missing.push('commits ahead');
  return missing;
}

export function planWorktreeRemoval(
  records: readonly WorktreeRecord[],
  opts: { nowMs: number; minAgeHours?: number },
): RemovalPlanReport {
  const minAgeHours = opts.minAgeHours !== undefined && Number.isFinite(opts.minAgeHours) && opts.minAgeHours >= 0
    ? opts.minAgeHours : DISK_PLAN_MIN_AGE_HOURS;
  const zero = (): Record<WorktreeResult, number> => Object.fromEntries(WORKTREE_RESULTS.map(r => [r, 0])) as Record<WorktreeResult, number>;
  const gbByResult = zero();
  const countByResult = zero();
  const bytesByResult = zero();
  const planned: Array<PlanFolder & { bytes: number }> = [];
  const notSure: PlanKept[] = [];
  const unpublished: PlanFolder[] = [];
  const kept: PlanKept[] = [];

  for (const r of records) {
    countByResult[r.result]++;
    if (r.bytes !== null) bytesByResult[r.result] += r.bytes;
    const folder: PlanFolder = { jobId: r.jobId, gb: gbOf(r.bytes), result: r.result };
    if (r.result === 'publish-aborted') { unpublished.push(folder); continue; }
    const missing = unknownFields(r);
    if (missing.length > 0) { notSure.push({ ...folder, reason: `${missing.join(', ')} unknown` }); continue; }
    const ageHours = (opts.nowMs - r.modifiedMs!) / HOUR_MS;
    const reason = r.result === 'running' ? 'job is running'
      : r.result === 'pr-open' ? 'pull request is still open'
      : r.uncommitted === 'yes' ? 'has uncommitted changes'
      : r.commitsAhead! > 0 ? `${r.commitsAhead} commit${r.commitsAhead === 1 ? '' : 's'} ahead of base`
      : ageHours < minAgeHours ? `changed less than ${minAgeHours} hours ago`
      : null;
    if (reason) kept.push({ ...folder, reason });
    else planned.push({ ...folder, bytes: r.bytes! });
  }
  for (const result of WORKTREE_RESULTS) gbByResult[result] = round1(bytesByResult[result] / GB);

  const bySize = (a: { gb: number | null; jobId: string }, b: { gb: number | null; jobId: string }) =>
    (b.gb ?? -1) - (a.gb ?? -1) || a.jobId.localeCompare(b.jobId);
  planned.sort(bySize);
  const largest = records.filter(r => r.bytes !== null)
    .map(r => ({ jobId: r.jobId, gb: gbOf(r.bytes), result: r.result }))
    .sort(bySize).slice(0, 10);
  const planBytes = planned.reduce((sum, f) => sum + f.bytes, 0);
  return {
    schema: DISK_PLAN_SCHEMA,
    minAgeHours,
    folders: records.length,
    gbByResult,
    countByResult,
    largest,
    plan: { folders: planned.map(({ jobId, gb, result }) => ({ jobId, gb, result })), count: planned.length, gb: round1(planBytes / GB) },
    notSure: notSure.sort(bySize),
    unpublished: unpublished.sort(bySize),
    kept: kept.sort(bySize),
  };
}

export interface DiskPlanRunway {
  freeGb: number | null;
  /** GB lost per hour; null when unknown or not falling. */
  fallGbPerHour: number | null;
  floorGb: number;
  hoursUntilFloorNow: number | null;
  hoursUntilFloorIfApplied: number | null;
}

/** The trend plus the plan: how long to the floor now, and if the plan's GB came back. */
export function planRunway(trend: HostDiskTrend | null | undefined, planGb: number): DiskPlanRunway {
  const freeGb = trend?.freeGb ?? null;
  const floorGb = trend?.floorGb ?? 100;
  const fall = trend && trend.direction === 'falling' && trend.gbPerHour !== null && trend.gbPerHour > 0 ? trend.gbPerHour : null;
  const until = (free: number): number | null =>
    free <= floorGb ? 0 : fall === null ? null : round1((free - floorGb) / fall);
  return {
    freeGb,
    fallGbPerHour: fall === null ? null : round1(fall),
    floorGb,
    hoursUntilFloorNow: freeGb === null ? null : until(freeGb),
    hoursUntilFloorIfApplied: freeGb === null ? null : until(freeGb + planGb),
  };
}

const hoursWord = (h: number): string => (h < 1 ? 'under an hour' : `${h < 10 ? h : Math.round(h)} hours`);

/** The one plain sentence shown first in the CLI and on the card. Unknown is said as unknown. */
export function diskPlanSentence(runway: DiskPlanRunway, plan: RemovalPlanReport['plan']): string {
  const head = runway.freeGb === null ? 'Disk: free space unknown'
    : `Disk: ${Math.round(runway.freeGb)} GB free${runway.fallGbPerHour === null ? '' : `, falling ${Math.round(runway.fallGbPerHour)} GB an hour`}${
      runway.hoursUntilFloorNow === null ? '' : `, ${hoursWord(runway.hoursUntilFloorNow)} to the floor`}`;
  const tail = plan.count === 0 ? 'no finished job folders are safe to remove yet'
    : `${plan.count} finished job folder${plan.count === 1 ? '' : 's'} could free about ${Math.round(plan.gb)} GB`;
  return `${head}; ${tail}`;
}

export interface DiskPlanReportV1 {
  schema: typeof DISK_PLAN_SCHEMA;
  generatedAt: string;
  /** The same sentence the CLI prints first and the card shows. */
  sentence: string;
  runway: DiskPlanRunway;
  report: RemovalPlanReport;
  /** Plain gaps in what was read, so unknown stays visible. */
  gaps: string[];
}

export function buildDiskPlanReport(
  records: readonly WorktreeRecord[],
  trend: HostDiskTrend | null | undefined,
  opts: { nowMs: number; minAgeHours?: number; gaps?: string[] },
): DiskPlanReportV1 {
  const report = planWorktreeRemoval(records, opts);
  const runway = planRunway(trend, report.plan.gb);
  return {
    schema: DISK_PLAN_SCHEMA,
    generatedAt: new Date(opts.nowMs).toISOString(),
    sentence: diskPlanSentence(runway, report.plan),
    runway,
    report,
    gaps: opts.gaps ?? [],
  };
}

/** Human lines: the sentence first, then each list. */
export function formatDiskPlan(plan: DiskPlanReportV1): string[] {
  const { report, runway } = plan;
  const gb = (v: number | null): string => (v === null ? 'size unknown' : `${v} GB`);
  const lines = [plan.sentence];
  if (runway.hoursUntilFloorIfApplied !== null && runway.hoursUntilFloorNow !== null && report.plan.count > 0) {
    lines.push(`Floor ${runway.floorGb} GB: ${hoursWord(runway.hoursUntilFloorNow)} away now, ${hoursWord(runway.hoursUntilFloorIfApplied)} if the plan were applied.`);
  }
  lines.push('Read-only: nothing was removed.');
  const list = (title: string, items: ReadonlyArray<PlanFolder & { reason?: string }>, max = 10): void => {
    if (items.length === 0) return;
    lines.push('', `${title} (${items.length}):`);
    for (const f of items.slice(0, max)) lines.push(`  ${f.jobId}  ${gb(f.gb)}  ${f.result}${f.reason ? ` — ${f.reason}` : ''}`);
    if (items.length > max) lines.push(`  …and ${items.length - max} more (see --json)`);
  };
  list(`Safe to remove, ${report.plan.gb} GB`, report.plan.folders);
  list('Has unpublished work, recover first', report.unpublished);
  list('Not sure, kept', report.notSure);
  list('Ten largest folders', report.largest);
  lines.push('', 'GB by result:');
  for (const [result, value] of Object.entries(report.gbByResult)) {
    const n = report.countByResult[result as WorktreeResult];
    if (n > 0) lines.push(`  ${result}: ${value} GB in ${n} folder${n === 1 ? '' : 's'}`);
  }
  for (const gap of plan.gaps) lines.push(`Note: ${gap}`);
  return lines;
}
