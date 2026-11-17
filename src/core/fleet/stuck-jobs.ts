/**
 * Which queued jobs can never launch? Pure: text in, report out; no I/O, no clock.
 *
 * The dispatcher logs one line per tick for a job it cannot place or clean up,
 * for example `DEVIN_FLASH_REFUSED <job> size-not-sm` or
 * `WT_ORPHAN_REMOVE_FAILED <job> (RuntimeError)`. A job is stuck when it has
 * two or more such lines since its last `LAUNCH <job> ...` line and is still
 * logging them: its newest line is within STUCK_QUIET_MS of the newest line in
 * the log. A job that went quiet was fixed or removed, so it is left out.
 *
 * Any `*_REFUSED` or `*_FAILED` line that names a job counts. A cause this
 * module does not recognise is reported as `unknown`, never dropped.
 */
import { parseDispatchEventLine } from '../fabric/dispatch-events.js';

export type StuckCause = 'lane_refused_size' | 'lane_refused_repo' | 'worktree_cleanup_failed' | 'unknown';

export interface StuckJob {
  job: string;
  /** Lane from the ready list, else the lane that refused it, else null (unknown). */
  lane: string | null;
  cause: StuckCause;
  /** Refusal or failure lines since the last launch, within the part of the log that was read. */
  events: number;
  firstSeen: string;
  lastSeen: string;
  ageSeconds: number;
  /** One suggested next step in plain words. */
  action: string;
  /** Newest event kind and its reason text, as logged, so an unknown cause can be read. */
  kind: string;
  reason: string;
}

export interface StuckJobsReport {
  schema: 'fleet.stuck.v1';
  /** null when the event log could not be read: unknown, not zero. */
  count: number | null;
  oldestAgeSeconds: number | null;
  /** Oldest first. */
  jobs: StuckJob[];
}

/** A job with no refusal or failure line this long before the newest log line is no longer stuck. */
export const STUCK_QUIET_MS = 60 * 60_000;

export const STUCK_ACTIONS: Readonly<Record<StuckCause, string>> = {
  lane_refused_size: 'move to a lane that accepts this size',
  lane_refused_repo: 'move to a lane that accepts this repo',
  worktree_cleanup_failed: 'worktree cleanup keeps failing; needs a manual look',
  unknown: 'cause not recognised; read the event log lines for this job',
};

const TROUBLE = /_(?:REFUSED|FAILED)$/;
// Job ids start with a capital and carry a dash (RQ-X-1, FIXUP-CI-repo-1); "timeout" or a path is not a job.
const JOB = /^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9._]+)+$/;

function causeOf(kind: string, reason: string): StuckCause {
  if (kind === 'WT_ORPHAN_REMOVE_FAILED') return 'worktree_cleanup_failed';
  if (!kind.endsWith('_REFUSED')) return 'unknown';
  return reason === 'size-not-sm' ? 'lane_refused_size' : reason === 'repo-not-eligible' ? 'lane_refused_repo' : 'unknown';
}

/** `2h 5m`, `5d 2h`, `40s`: two units at most. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const [d, h, m] = [Math.floor(s / 86_400), Math.floor(s % 86_400 / 3600), Math.floor(s % 3600 / 60)];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}

/**
 * @param log   tail of the dispatch event log
 * @param lanes job id to assigned lane, from the ready list
 * @param now   clock for ages, in ms
 */
export function findStuckJobs(log: string, lanes: ReadonlyMap<string, string>, now: number): StuckJobsReport {
  const seen = new Map<string, { events: number; first: number; last: number; kind: string; reason: string }>();
  let newest = 0;
  for (const line of log.split('\n')) {
    const parsed = parseDispatchEventLine(line);
    if (!parsed.ok) continue;
    const { kind, message, at } = parsed.event;
    const ms = Date.parse(at);
    newest = Math.max(newest, ms);
    const [job = '', ...rest] = message.split(/\s+/);
    if (kind === 'LAUNCH') { seen.delete(job); continue; }
    if (!TROUBLE.test(kind) || !JOB.test(job)) continue;
    const row = seen.get(job) ?? { events: 0, first: ms, last: ms, kind, reason: '' };
    seen.set(job, { events: row.events + 1, first: Math.min(row.first, ms), last: Math.max(row.last, ms), kind, reason: rest.join(' ').slice(0, 120) });
  }
  const jobs = [...seen].filter(([, row]) => row.events >= 2 && newest - row.last <= STUCK_QUIET_MS).map(([job, row]): StuckJob => {
    const cause = causeOf(row.kind, row.reason);
    const refusedBy = row.kind.endsWith('_REFUSED') ? row.kind.slice(0, -'_REFUSED'.length).toLowerCase().replaceAll('_', '-') : null;
    return { job, lane: lanes.get(job) ?? refusedBy, cause, events: row.events, firstSeen: new Date(row.first).toISOString(),
      lastSeen: new Date(row.last).toISOString(), ageSeconds: Math.max(0, Math.round((now - row.first) / 1000)),
      action: STUCK_ACTIONS[cause], kind: row.kind, reason: row.reason };
  }).sort((a, b) => b.ageSeconds - a.ageSeconds || a.job.localeCompare(b.job));
  return { schema: 'fleet.stuck.v1', count: jobs.length, oldestAgeSeconds: jobs[0]?.ageSeconds ?? null, jobs };
}

/** One plain line per stuck job. */
export function stuckJobLine(row: StuckJob): string {
  return `${row.job}: stuck ${formatAge(row.ageSeconds)} on lane ${row.lane ?? 'unknown'}; cause ${row.cause}; ${row.events} events; ${row.action}.`;
}

/** The fleet vitals row. */
export function stuckSummaryLine(report: Pick<StuckJobsReport, 'count' | 'oldestAgeSeconds'>): string {
  if (report.count === null) return 'Jobs stuck: unknown';
  const jobs = `${report.count} ${report.count === 1 ? 'job' : 'jobs'} stuck`;
  return report.oldestAgeSeconds === null ? jobs : `${jobs}; oldest ${formatAge(report.oldestAgeSeconds)}`;
}
