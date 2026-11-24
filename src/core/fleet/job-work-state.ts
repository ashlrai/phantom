/**
 * job-work-state.ts — one honest work state per job: RECEIVED, ASSIGNED,
 * RUNNING, BLOCKED or VERIFIED (the Nov 12-13 reporting contract), or UNKNOWN
 * when no host file names the job. "Routed" is never a state.
 *
 * `workStateOf` is pure. `readJobWorkState` reads, read-only and bounded:
 *   queue/router-queue.md        - READY / CLAIMED lines
 *   queue/ready.tsv              - queued, with the lane
 *   queue/run/<id>.launches/.rc  - started / finished with an exit code
 *   <runs>/<id>.publish          - `RESULT PR <url>` or `RESULT EMPTY <reason>`
 * Publication results outrank exit, launch and queue evidence, but a PR URL
 * proves publication only; head and test verification remain unavailable.
 * `phm jobs state` and the Slack/iMessage status reply both call this.
 */
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { JOB_ID_PATTERN, parsePublishResult } from './job-state.js';
import { parseReadyTsv } from './lane-console.js';
import { readyJobs } from './empty-family-apply.js';

export type WorkStateName = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED' | 'UNKNOWN';

export interface JobWorkState {
  job: string;
  state: WorkStateName;
  /** ISO time of the newest file that decided the state; null when unknown. */
  as_of: string | null;
  /** The file that decided it, relative to the runs folder. */
  source: string | null;
  /** Named owner for ASSIGNED, when supported by durable evidence. */
  owner: string | null;
  /** Plain words describing the result, block, or queue context. */
  detail: string | null;
  evidence: string[];
}

/** One file's text and mtime, or null when it is missing. */
export interface Seen { text: string; mtimeMs: number }

export interface WorkStateEvidence {
  job: string;
  publish: Seen | null;
  rc: Seen | null;
  launches: Seen | null;
  readyTsv: Seen | null;
  routerQueue: Seen | null;
}

const iso = (s: Seen): string => new Date(s.mtimeMs).toISOString();

/** The words after `RESULT EMPTY`, or null when the record names no reason. */
function emptyReason(publish: string): string | null {
  const last = publish.split('\n').map(l => l.trim()).filter(l => /^RESULT\b/.test(l)).pop() ?? '';
  const why = /^RESULT\s+EMPTY\s*[:-]?\s*(.+)$/.exec(last)?.[1]?.trim();
  return why ? why.slice(0, 200) : null;
}

export function workStateOf(e: WorkStateEvidence): JobWorkState {
  const base = { job: e.job, owner: null, detail: null, evidence: [] as string[] };
  const make = (state: WorkStateName, seen: Seen | null, source: string | null, extra: Partial<JobWorkState> = {}): JobWorkState =>
    ({ ...base, ...extra, state, as_of: seen ? iso(seen) : null, source, evidence: [...(extra.evidence ?? [])] });

  if (e.publish) {
    const { result } = parsePublishResult(e.publish.text);
    const emptyWithReason = result === null && /^RESULT\s+EMPTY\s*:/m.test(e.publish.text);
    if (result?.kind === 'pr') {
      return make('BLOCKED', e.publish, `${e.job}.publish`, { detail: `PR published; head and test verification evidence unavailable: ${result.url}`, evidence: [`publish record says RESULT PR ${result.url}`] });
    }
    if (result?.kind === 'empty' || emptyWithReason) {
      const why = emptyReason(e.publish.text);
      const detail = why ?? 'finished with no change and no reason recorded';
      return make('BLOCKED', e.publish, `${e.job}.publish`, { detail, evidence: [`publish record says RESULT EMPTY${why ? `: ${why}` : ' with no reason'}`] });
    }
  }
  if (e.rc) {
    const code = /^\s*(-?\d{1,3})\s*$/.exec(e.rc.text.slice(0, 32))?.[1];
    if (code !== undefined && Number(code) !== 0) {
      return make('BLOCKED', e.rc, `queue/run/${e.job}.rc`, { detail: `worker exited with code ${code}`, evidence: [`exit code ${code}`] });
    }
    if (code === '0') {
      return make('BLOCKED', e.rc, `queue/run/${e.job}.rc`, { detail: 'worker finished but left no PR or result', evidence: ['exit code 0, no publish record'] });
    }
    // An rc file we cannot read says nothing; fall through to older evidence.
  }
  if (e.launches) {
    return make('RUNNING', e.launches, `queue/run/${e.job}.launches`, { evidence: ['launched, no exit code yet'] });
  }
  const ready = e.readyTsv ? parseReadyTsv(e.readyTsv.text).rows.find(r => r.id === e.job) : undefined;
  if (e.readyTsv && ready?.pool) {
    const detail = `queued for lane ${ready.pool}; lane is a queue destination, not an assigned owner`;
    return make('RECEIVED', e.readyTsv, 'queue/ready.tsv', { detail, evidence: [detail] });
  }
  if (e.routerQueue) {
    const line = e.routerQueue.text.split(/\r?\n/).find(l => new RegExp(`^- CLAIMED ${e.job.replace(/[.]/g, '\\.')}(\\s|$)`).test(l));
    if (line) {
      const detail = 'marked CLAIMED, but named owner and durable claim/task receipt are not evidenced';
      return make('RECEIVED', e.routerQueue, 'queue/router-queue.md', { detail, evidence: [detail] });
    }
    if (readyJobs(e.routerQueue.text).some(j => j.id === e.job)) {
      return make('RECEIVED', e.routerQueue, 'queue/router-queue.md', { evidence: ['READY in the queue, no lane yet'] });
    }
  }
  return make('UNKNOWN', null, null, { evidence: ['no host file names this job'] });
}

/** One plain line for Slack/iMessage: state, detail, as-of and source. */
export function formatWorkState(s: JobWorkState): string {
  if (s.state === 'UNKNOWN') return `${s.job}: UNKNOWN (no host file names this job)`;
  const extra = s.state === 'ASSIGNED' && s.owner ? ` to ${s.owner}` : s.detail ? ` - ${s.detail}` : '';
  return `${s.job}: ${s.state}${extra} (as of ${s.as_of}, source ${s.source})`;
}

const READ_BYTES = 1024 * 1024;

async function seen(path: string, tail = false): Promise<Seen | null> {
  try {
    const s = await lstat(path);
    if (!s.isFile()) return null;
    const length = Math.min(s.size, READ_BYTES);
    const fh = await open(path);
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, tail ? s.size - length : 0);
      return { text: buf.toString('utf8', 0, bytesRead), mtimeMs: s.mtimeMs };
    } finally { await fh.close(); }
  } catch { return null; }
}

export async function readJobWorkState(job: string, options: { runsDir?: string } = {}): Promise<JobWorkState> {
  if (!JOB_ID_PATTERN.test(job)) throw new Error('invalid fleet job id');
  const runsDir = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new Error('runsDir must be an absolute path');
  const [publish, rc, launches, readyTsv, routerQueue] = await Promise.all([
    seen(join(runsDir, `${job}.publish`), true),
    seen(join(runsDir, 'queue', 'run', `${job}.rc`)),
    seen(join(runsDir, 'queue', 'run', `${job}.launches`)),
    seen(join(runsDir, 'queue', 'ready.tsv')),
    seen(join(runsDir, 'queue', 'router-queue.md')),
  ]);
  return workStateOf({ job, publish, rc, launches, readyTsv, routerQueue });
}
