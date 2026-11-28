/**
 * dispatch-stuck.ts — the file-reading half of `phm fleet stuck`
 * (`fleet.stuck.v1`): which queued jobs can never launch? The pure fold
 * lives in stuck-jobs.ts; this module binds it to the dispatch event log
 * tail, the ready list and router-queue.md on the shared runs dir, so the
 * CLI, `phm fleet vitals` and the unified comms inbox's `dispatch-stuck`
 * source all resolve the same stuck set and can never disagree.
 *
 * An unreadable or absent event log gives `count: null` — unknown, never
 * zero: the log is the only witness a job is being refused, so its absence
 * proves nothing about the queue. The ready list only attributes lanes; a
 * ready read that is not healthy leaves lanes to the refusing lane or
 * unknown (`sources.ready` says which).
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultDispatchEventsPath } from '../fabric/dispatch-events.js';
import { parseReadyTsv } from './lane-console.js';
import { readSource, type Source } from './runs-parked-queue.js';
import { findStuckJobs, type StuckJobsReport } from './stuck-jobs.js';

/** Only the end of the event log is read: it grows without bound. About 50,000 lines. */
const EVENTS_TAIL_BYTES = 4 * 1024 * 1024;
const READY_MAX_BYTES = 8 * 1024 * 1024;
/** router-queue.md is append-mostly Markdown history; same 32 MiB bound the other market readers use. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

export interface DispatchStuckRead extends StuckJobsReport {
  /** State of each file read. A ready list that is not healthy leaves lanes to the refusing lane or unknown. */
  sources: { events: Source; ready: Source };
}

export interface DispatchStuckPaths { runsDir?: string; events?: string; ready?: string }

/** Read the event log tail and the ready list. An unreadable log gives count null (unknown), never zero. */
export async function readDispatchStuckJobs(paths: DispatchStuckPaths = {}, now = Date.now()): Promise<DispatchStuckRead> {
  const runs = paths.runsDir ?? (process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'));
  const readyPath = paths.ready ?? join(runs, 'queue', 'ready.tsv');
  const [events, ready, router] = await Promise.all([
    readSource(paths.events ?? await defaultDispatchEventsPath(runs), EVENTS_TAIL_BYTES, true),
    readSource(readyPath, READY_MAX_BYTES, false),
    readSource(join(dirname(readyPath), 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES, false),
  ]);
  const sources = { events: events.state, ready: ready.state };
  if (events.state !== 'healthy') return { schema: 'fleet.stuck.v1', count: null, oldestAgeSeconds: null, jobs: [], sources };
  const lanes = new Map<string, string>();
  for (const row of parseReadyTsv(ready.text, router.state === 'healthy' ? router.text : null).rows) if (row.id && row.pool) lanes.set(row.id, row.pool);
  return { ...findStuckJobs(events.text, lanes, now), sources };
}
