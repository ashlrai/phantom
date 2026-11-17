/** `phm fleet stuck`: read-only list of queued jobs that can never launch. Logic: core/fleet/stuck-jobs.ts. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultDispatchEventsPath } from '../core/fabric/dispatch-events.js';
import { parseReadyTsv } from '../core/fleet/lane-console.js';
import { readSource, type Source } from '../core/fleet/runs-parked-queue.js';
import { findStuckJobs, stuckJobLine, type StuckJobsReport } from '../core/fleet/stuck-jobs.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Only the end of the event log is read: it grows without bound. About 50,000 lines. */
const EVENTS_TAIL_BYTES = 4 * 1024 * 1024;
const READY_MAX_BYTES = 8 * 1024 * 1024;

export interface StuckJobsRead extends StuckJobsReport {
  /** State of each file read. A ready list that is not healthy leaves lanes to the refusing lane or unknown. */
  sources: { events: Source; ready: Source };
}

export interface StuckJobsPaths { runsDir?: string; events?: string; ready?: string }

/** Read the event log tail and the ready list. An unreadable log gives count null (unknown), never zero. */
export async function readStuckJobs(paths: StuckJobsPaths = {}, now = Date.now()): Promise<StuckJobsRead> {
  const runs = paths.runsDir ?? (process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'));
  const [events, ready] = await Promise.all([
    readSource(paths.events ?? await defaultDispatchEventsPath(runs), EVENTS_TAIL_BYTES, true),
    readSource(paths.ready ?? join(runs, 'queue', 'ready.tsv'), READY_MAX_BYTES, false),
  ]);
  const sources = { events: events.state, ready: ready.state };
  if (events.state !== 'healthy') return { schema: 'fleet.stuck.v1', count: null, oldestAgeSeconds: null, jobs: [], sources };
  const lanes = new Map<string, string>();
  for (const row of parseReadyTsv(ready.text).rows) if (row.id && row.pool) lanes.set(row.id, row.pool);
  return { ...findStuckJobs(events.text, lanes, now), sources };
}

const USAGE = 'Usage: phm fleet stuck [--runs-dir <directory>] [--events <file>] [--ready <file>] [--json]\nList queued jobs that keep being refused or keep failing and have not launched since: lane, cause, how long, and what to do next. Reads the end of the dispatch event log and the ready list; changes nothing. Exit 1 when the event log cannot be read.';

export async function cmdFleetStuck(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const paths: StuckJobsPaths = {};
  const flags = { '--runs-dir': 'runsDir', '--events': 'events', '--ready': 'ready' } as const;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !(arg === '--json' || arg in flags)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('-')) { console.error(USAGE); return 2; }
    paths[flags[arg as keyof typeof flags]] = value;
  }
  const report = sanitizePublicJson(await readStuckJobs(paths)) as StuckJobsRead;
  if (seen.has('--json')) console.log(JSON.stringify(report));
  else if (report.count === null) console.log(`Stuck jobs: unknown; the dispatch event log is ${report.sources.events === 'missing' ? 'missing' : 'unreadable'}.`);
  else if (report.count === 0) console.log('No stuck jobs.');
  else for (const row of report.jobs) console.log(stuckJobLine(row));
  return report.count === null ? 1 : 0;
}
