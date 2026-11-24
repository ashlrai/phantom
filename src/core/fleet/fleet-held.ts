/**
 * Jobs and lanes that count as launched or staffed but are not actually running.
 * Pure: no I/O. `readFleetRunsDirState` supplies the inputs and carries the
 * result as `notRunning`, so the CLI, the fleet API and the desktop share one list.
 */
import { laneLaunchTarget } from './lane-launch-target.js';
import { ledgerAtMs, ledgerEventName, ledgerJobId, ledgerLane } from './empty-cause.js';

export type NotRunningKind = 'held_launch' | 'idle_lane' | 'launched_no_finish' | 'finished_no_publish';
export interface NotRunningRow {
  job_or_lane: string; kind: NotRunningKind; reason: string;
  /** When the state began, ISO; null when not known. */
  since: string | null;
  /** One plain sentence, or "unknown" when the reason is not recognized. */
  unblock: string;
}
/** One `<job>.launch` file: its first line, its modified time and whether `<job>.publish` exists. */
export interface LaunchRecord { job: string; firstLine: string; at: string; lane?: string | null; published?: boolean }
export interface NotRunningLane { lane: string; running: number; target: number; queued: number; held: boolean; heldReason?: string | null;
  /** The controller's load-shed ceiling; absent keeps the configured target as the launch target. */
  effectiveTarget?: number | null }
export interface NotRunningInput {
  lanes: readonly NotRunningLane[]; launches: readonly LaunchRecord[];
  /** Tail of metrics/jobs.jsonl; null when unreadable, which leaves finish and publish states unknown (not listed). */
  metricsTail: string | null;
  /** True when older metrics rows were cut off, so a finish may predate the tail. */
  metricsClipped?: boolean;
  now: number; limit?: number;
}

export const LAUNCH_NO_FINISH_MS = 60 * 60_000;
/** A finish needs this long before a missing publish counts, and stops counting after a day. */
export const PUBLISH_GRACE_MS = 10 * 60_000;
export const PUBLISH_WINDOW_MS = 24 * 3_600_000;
const KINDS: NotRunningKind[] = ['held_launch', 'idle_lane', 'launched_no_finish', 'finished_no_publish'];

const named = (lane: string | null): string => lane ? lane[0]!.toUpperCase() + lane.slice(1) : 'this lane';
/** Known hold reasons and the one step that clears each. First match wins. */
const RULES: ReadonlyArray<[RegExp, (lane: string | null) => string]> = [
  [/reading older than|stale (?:usage|reading)|usage (?:reading )?(?:is )?(?:stale|unknown)/i,
    lane => lane ? `Record a current ${named(lane)} usage percent` : 'Record a current usage percent for this lane'],
  [/launches paused|^PAUSED\b/i, () => 'Resume launches for this lane'],
  [/not signed in|sign-in needed|auth\.json|api[_ ]key|\.key refused|token not provisioned/i, lane => `Sign in to ${named(lane)} again on the host`],
  [/not installed|not the pinned version|not provisioned/i, () => 'Install the pinned tool version on the host'],
  [/unhealthy|not running|provider unavailable/i, () => 'Start the provider service on the host'],
  [/kernel pressure|memory|disk/i, () => 'Free memory or disk on the host'],
  [/lane cap/i, () => 'Wait for a running job to finish or raise the lane target'],
  [/repo lock|fetch failed|no origin\//i, () => 'Check the repository checkout and network on the host'],
];
/** The step for a hold reason, or "unknown" when no rule recognizes it. */
export function unblockFor(reason: string, lane: string | null = null): string {
  return RULES.find(([pattern]) => pattern.test(reason))?.[1](lane) ?? 'unknown';
}

/** ISO times as dispatchd writes them, including a space for T and offsets without a colon. */
function time(value: unknown): number {
  return typeof value !== 'string' ? NaN
    : Date.parse(value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}
const iso = (ms: number): string => new Date(ms).toISOString();

interface JobFacts { open: number; launch: number; finish: number; empty: boolean; publish: number; lane: string | null }

export function fleetNotRunning(input: NotRunningInput): NotRunningRow[] {
  const { now } = input;
  const jobs = new Map<string, JobFacts>(), laneLast = new Map<string, number>();
  let tailStart = Infinity;
  for (const line of (input.metricsTail ?? '').split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try { const v: unknown = JSON.parse(line); if (!v || typeof v !== 'object' || Array.isArray(v)) continue; row = v as Record<string, unknown>; }
    catch { continue; }
    const at = ledgerAtMs(row);
    const job = ledgerJobId(row);
    if (job === null || at === null || at > now) continue;
    tailStart = Math.min(tailStart, at);
    const lane = ledgerLane(row);
    if (lane) laneLast.set(lane, Math.max(laneLast.get(lane) ?? -Infinity, at));
    const f = jobs.get(job) ?? { open: NaN, launch: -Infinity, finish: -Infinity, empty: false, publish: -Infinity, lane: null };
    jobs.set(job, f);
    if (lane) f.lane = lane;
    const event = ledgerEventName(row);
    if (event === 'launch' || event === 'claim') { f.launch = Math.max(f.launch, at); if (!Number.isFinite(f.open)) f.open = at; }
    else if (event === 'finish' && at >= f.finish) { f.finish = at; f.empty = row.empty === true; f.open = NaN; }
    else if (event === 'publish') f.publish = Math.max(f.publish, at);
  }
  const rows: NotRunningRow[] = [], recorded = new Map<string, LaunchRecord>();
  for (const record of input.launches) {
    recorded.set(record.job, record);
    const at = time(record.at), line = record.firstLine.trim(), facts = jobs.get(record.job);
    if (!line || !Number.isFinite(at)) continue; // An empty record is a launch still starting.
    if (!/^launched\b/.test(line)) {
      const unblock = unblockFor(line, record.lane ?? facts?.lane ?? null);
      // The record is rewritten on every retry; the first unfinished launch in the metrics tail is the real start.
      const since = facts && Number.isFinite(facts.open) ? Math.min(facts.open, at) : at;
      rows.push({ job_or_lane: record.job, kind: 'held_launch', since: iso(since), unblock,
        reason: unblock === 'unknown' ? line : line.replace(/^(?:HELD|PAUSED):\s*/, '') });
    } else if (input.metricsTail !== null && !record.published && now - at >= LAUNCH_NO_FINISH_MS
      && !(facts && (facts.finish >= at - 60_000 || facts.publish >= at - 60_000))
      && !(input.metricsClipped && !(tailStart <= at))) {
      rows.push({ job_or_lane: record.job, kind: 'launched_no_finish', since: iso(at),
        reason: 'No finish recorded more than 60 minutes after launch', unblock: 'Check the job log, then stop or requeue the job' });
    }
  }
  for (const [job, f] of jobs) {
    const age = now - f.finish;
    // An empty finish has nothing to publish; a later launch means the job is running again.
    if (f.empty || !(age >= PUBLISH_GRACE_MS && age <= PUBLISH_WINDOW_MS) || f.launch > f.finish) continue;
    if (recorded.get(job)?.published || f.publish >= (Number.isFinite(f.launch) ? f.launch : -Infinity)) continue;
    rows.push({ job_or_lane: job, kind: 'finished_no_publish', since: iso(f.finish),
      reason: 'Finished with no publish record', unblock: 'Republish this job or requeue it' });
  }
  for (const lane of input.lanes) {
    // A lane the controller shed to zero launch slots is curtailed, not idle.
    if (!(laneLaunchTarget(lane.target, lane.effectiveTarget) > 0) || lane.running !== 0 || lane.queued !== 0) continue;
    const last = laneLast.get(lane.lane);
    const known = lane.held ? unblockFor(lane.heldReason ?? '', lane.lane) : 'Queue work for this lane';
    rows.push({ job_or_lane: lane.lane, kind: 'idle_lane', since: last === undefined ? null : iso(last),
      reason: lane.held ? `Lane held${lane.heldReason ? `: ${lane.heldReason}` : ''}` : 'Target above 0 with nothing running and nothing queued',
      unblock: known === 'unknown' ? 'Release the hold on this lane' : known });
  }
  // Group by kind, then longest-standing first; unknown start times last.
  const order = (row: NotRunningRow): number => row.since === null ? Infinity : Date.parse(row.since);
  return rows.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || order(a) - order(b) || a.job_or_lane.localeCompare(b.job_or_lane))
    .slice(0, Math.max(0, input.limit ?? 200));
}

export function formatNotRunning(rows: readonly NotRunningRow[]): string {
  if (rows.length === 0) return 'Nothing is stuck: every launched job is running or finished, and no lane sits idle.';
  return [`Not actually running: ${rows.length}`, ...rows.flatMap(row => [
    `${row.job_or_lane}  ${row.kind}${row.since ? `  since ${row.since}` : ''}`, `  Why: ${row.reason}`, `  Next: ${row.unblock}`])].join('\n');
}
