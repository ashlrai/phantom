/**
 * runs-job-window.ts — gathers one job's facts from the runs directory and
 * hands them to buildJobWindow (job-window.ts). Served by
 * GET /api/fleet/job/window?id=<J>[&lines=N][&after=<cursor>] and printed by
 * `phm job show <id>`.
 *
 * READ-ONLY, built on the existing readers, never a second copy of them:
 *  - getFleetJobTail: state, lane, tier, model, start, PR, repo, ledger events.
 *  - readJobState: whether the publish record said RESULT EMPTY.
 *  - readFleetJobLog: whole, redacted log lines and the tail cursor.
 *  - queue/job-stops.jsonl (written by job-stop.ts): who stopped this attempt.
 * Every source is bounded and independently guarded; a missing one leaves
 * its facts null ("unknown"), never invented.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { buildJobWindow, type FleetJobWindowV1 } from './job-window.js';
import { readJobState } from './job-state.js';
import { JOB_STOPS_FILE } from './job-stop.js';
import { isFleetJobId, scrubJobLogLine } from './runs-job-detail.js';
import { getFleetJobTail, readFleetJobLog, readWindow, type FleetJobTailEvent } from './runs-job-tail.js';

export interface FleetJobWindowOptions {
  runsDir?: string;
  /** Last N log lines (1..200, default 40); with `after`, at most N new lines. */
  lines?: number;
  /** Tail cursor from an earlier window: return only lines written after it. */
  after?: number | null;
  now?: () => Date;
}

const STOPS_BYTES = 128 * 1024;
const FINISH_EVENTS = /^(finish|publish|outcome|task_outcome|terminal)\b/;

/** The newest applied stop for `job` at or after this attempt's start. */
async function readStop(runsDir: string, job: string, startedAt: string | null): Promise<{ at: string | null; by: string | null } | null> {
  const window = await readWindow(join(runsDir, JOB_STOPS_FILE), null, STOPS_BYTES).catch(() => null);
  if (!window) return null;
  const started = startedAt ? Date.parse(startedAt) : NaN;
  let stop: { at: string | null; by: string | null } | null = null;
  for (const line of window.data.toString('utf8').split('\n')) {
    if (!line.includes(job)) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r['id'] !== job || r['outcome'] !== 'stopped') continue;
    const at = typeof r['at'] === 'string' ? r['at'] : null;
    // A stop from an earlier attempt under the same id does not stop this one.
    if (at && Number.isFinite(started) && Date.parse(at) < started) continue;
    stop = { at, by: typeof r['by'] === 'string' ? scrubJobLogLine(r['by']).slice(0, 80) : null };
  }
  return stop;
}

/** The newest finish-like ledger event's own time. */
function finishedAt(events: readonly FleetJobTailEvent[]): string | null {
  let at: string | null = null;
  for (const e of events) if (e.source === 'event' && e.ts && FINISH_EVENTS.test(e.text)) at = e.ts;
  return at;
}

export async function getFleetJobWindow(job: string, options: FleetJobWindowOptions = {}): Promise<FleetJobWindowV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const lines = Math.max(1, Math.min(200, Math.floor(options.lines ?? 40)));
  const after = options.after ?? null;
  const now = options.now?.() ?? new Date();
  const [tail, result] = await Promise.all([
    getFleetJobTail(job, { runsDir, lines, now: () => now }),
    readJobState(job, { runsDir, now: () => now.getTime() }).catch(() => null),
  ]);
  const d = tail.detail;
  const [stop, log] = await Promise.all([
    readStop(runsDir, job, d.launchedAt),
    readFleetJobLog(job, { runsDir, after, lines, final: d.state !== 'running' }),
  ]);
  const archived = after === null && log.cursor === null;
  return buildJobWindow({
    job: tail.job,
    detailState: d.state,
    lane: d.lane, model: d.model, repo: d.repo, tier: d.tier,
    startedAt: d.launchedAt,
    finishedAt: finishedAt(tail.events),
    prUrl: d.prUrl,
    resultEmpty: result?.result?.kind === 'empty',
    stop,
    note: tail.status === 'unknown' ? tail.message : null,
    // No live log: a finished job's archived lines come through the tail snapshot (already redacted).
    lines: archived ? tail.events.filter(e => e.source === 'log').map(e => e.text) : log.lines,
    cursor: log.cursor ?? (after === null ? null : after),
    truncated: archived ? tail.truncated : log.truncated,
    more: log.more,
    since: after,
  });
}
