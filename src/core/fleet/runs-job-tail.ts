/**
 * runs-job-tail.ts — `phm job tail <id>` (fleet.job.tail.v1): a live window
 * into one fleet job, built on the same reads as the desktop worker-log pane
 * (getFleetJobDetail for status/model/lane/start/PR and the log tail, the
 * metrics ledger for lifecycle events) and the same plain words
 * (describeJob in job-tail-words.ts).
 *
 * Every line that leaves this module — log, ledger event or status — passes
 * through `redact`, which defaults to scrubJobLogLine, the redaction the job
 * detail API already applies. Follow mode reads only bytes appended after the
 * snapshot cursor, lstat-first (symlinks are never followed), bounded per tick.
 */

import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describeJob, type JobTailStatus } from './job-tail-words.js';
import { parseJobLedgerEvents } from './runs-job-activity.js';
import { getFleetJobDetail, isFleetJobId, scrubJobLogLine, type FleetJobDetailV1 } from './runs-job-detail.js';
import { readSource } from './runs-parked-queue.js';

export interface FleetJobTailEvent {
  /** ISO time: the ledger row's own time, or when follow first saw a log line; null for history log lines (the log has no per-line clock). */
  ts: string | null;
  source: 'log' | 'event' | 'status';
  text: string;
}

export interface FleetJobTailV1 {
  schema: 'fleet.job.tail.v1';
  generatedAt: string;
  job: string;
  status: JobTailStatus;
  /** Plain-words header: state, lane, model, start time and PR when known. */
  headline: string;
  /** Plain-words status sentence (unknown, finished with result, no log yet); null when the log speaks for itself. */
  message: string | null;
  detail: Pick<FleetJobDetailV1, 'state' | 'lane' | 'tier' | 'model' | 'launchedAt'> & { prUrl: string | null };
  events: FleetJobTailEvent[];
  truncated: boolean;
  /** Byte offsets follow mode resumes from; null when that file is absent. */
  cursor: { log: number | null; ledger: number | null };
}

export interface FleetJobTailOptions {
  runsDir?: string;
  /** Last N log lines (1..120, default 40) and at most N ledger events. */
  lines?: number;
  now?: () => Date;
  redact?: (line: string) => string;
}

export interface FollowOptions extends Omit<FleetJobTailOptions, 'lines'> {
  intervalMs?: number;
  signal?: AbortSignal;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onEvent: (event: FleetJobTailEvent) => void;
}

const MAX_LINES = 120;
const LEDGER_BYTES = 512 * 1024;
const FOLLOW_CHUNK = 256 * 1024;

const ledgerPath = (runsDir: string) => join(runsDir, 'metrics', 'jobs.jsonl');
const resolveRunsDir = (runsDir?: string): string => {
  const dir = runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new Error('runsDir must be an absolute path');
  return dir;
};

async function regularSize(path: string): Promise<number | null> {
  try { const st = await lstat(path); return st.isFile() ? st.size : null; } catch { return null; }
}

/** Bytes appended to a regular file since `offset`, capped per call. A shrunk file restarts at 0. */
async function readAppended(path: string, offset: number): Promise<{ text: string; next: number; reset: boolean } | null> {
  const size = await regularSize(path);
  if (size === null) return null;
  const reset = size < offset;
  const from = reset ? 0 : offset;
  const length = Math.min(size - from, FOLLOW_CHUNK);
  if (length <= 0) return { text: '', next: from, reset };
  const fh = await open(path);
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, from);
    // Stop at the last newline so a multi-byte character or a half-written line is never split.
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
    return { text: buf.toString('utf8', 0, end), next: from + end, reset };
  } finally { await fh.close(); }
}

function headline(d: FleetJobDetailV1): string {
  return [`Job ${d.job}`, d.state, [d.lane, d.tier].filter(Boolean).join(' ') || null, d.model,
    d.launchedAt ? `started ${d.launchedAt}` : null, d.publish?.prUrl ? `PR ${d.publish.prUrl}` : null]
    .filter(Boolean).join(' · ');
}

const ledgerEvent = (e: { at: string | null; event: string; summary: string }, redact: (l: string) => string): FleetJobTailEvent =>
  ({ ts: e.at, source: 'event', text: redact([e.event, e.summary].filter(Boolean).join(' ')) });

/** One snapshot: header, plain-words status, newest ledger events, then the last N log lines. */
export async function getFleetJobTail(job: string, options: FleetJobTailOptions = {}): Promise<FleetJobTailV1> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const runsDir = resolveRunsDir(options.runsDir);
  const now = options.now?.() ?? new Date();
  const lines = Math.max(1, Math.min(MAX_LINES, Math.floor(options.lines ?? 40)));
  const redact = options.redact ?? scrubJobLogLine;
  const [detail, ledger, logSize, ledgerSize] = await Promise.all([
    getFleetJobDetail(job, { runsDir, now: () => now, maxTailLines: lines }),
    readSource(ledgerPath(runsDir), LEDGER_BYTES, true),
    regularSize(join(runsDir, `${job}.log`)),
    regularSize(ledgerPath(runsDir)),
  ]);
  const { events: ledgerRows, clipped } = parseJobLedgerEvents(ledger.text, job, lines);
  const words = describeJob({ ...detail, sources: { ...detail.sources } }, now.getTime());
  // Ledger rows alone make a job known even when its run files are gone.
  const status: JobTailStatus = words.status === 'unknown' && ledgerRows.length > 0 ? 'no-log' : words.status;
  const message = status === 'no-log' && words.status === 'unknown' ? 'No log on this machine; only ledger events are recorded.' : words.text;
  return {
    schema: 'fleet.job.tail.v1',
    generatedAt: now.toISOString(),
    job: detail.job,
    status,
    headline: redact(headline(detail)),
    message: message === null ? null : redact(message),
    detail: { state: detail.state, lane: detail.lane, tier: detail.tier, model: detail.model, launchedAt: detail.launchedAt, prUrl: detail.publish?.prUrl ?? null },
    events: [
      ...ledgerRows.map(e => ledgerEvent(e, redact)),
      ...detail.log.tail.map((text): FleetJobTailEvent => ({ ts: null, source: 'log', text: redact(text) })),
    ],
    truncated: detail.log.truncated || clipped,
    cursor: { log: detail.log.source === 'live' ? logSize : null, ledger: ledgerSize },
  };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * Stream new log lines and ledger events after `cursor` until the job
 * finishes (emits one final status event and resolves 'finished') or the
 * signal aborts (resolves 'stopped'). Never throws on fs input.
 */
export async function followFleetJobTail(job: string, cursor: FleetJobTailV1['cursor'], options: FollowOptions): Promise<'finished' | 'stopped'> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const runsDir = resolveRunsDir(options.runsDir);
  const redact = options.redact ?? scrubJobLogLine;
  const clock = () => (options.now?.() ?? new Date());
  const wait = options.wait ?? sleep;
  const intervalMs = options.intervalMs ?? 2000;
  let log = cursor.log ?? 0;
  let ledger = cursor.ledger ?? 0;
  while (!options.signal?.aborted) {
    const ts = clock().toISOString();
    const appended = await readAppended(join(runsDir, `${job}.log`), log).catch(() => null);
    if (appended) {
      log = appended.next;
      for (const text of appended.text.split('\n').slice(0, -1)) options.onEvent({ ts, source: 'log', text: redact(text) });
    }
    const rows = await readAppended(ledgerPath(runsDir), ledger).catch(() => null);
    if (rows) {
      ledger = rows.next;
      for (const e of parseJobLedgerEvents(rows.text, job, Number.MAX_SAFE_INTEGER).events) options.onEvent(ledgerEvent(e, redact));
    }
    const detail = await getFleetJobDetail(job, { runsDir, now: clock, maxTailLines: 1 }).catch(() => null);
    if (detail && (detail.state === 'published' || detail.state === 'archived')) {
      options.onEvent({ ts, source: 'status', text: redact(describeJob(detail, Date.parse(ts)).text ?? `Job ${job} finished.`) });
      return 'finished';
    }
    if (options.signal?.aborted) break;
    await wait(intervalMs, options.signal);
  }
  return 'stopped';
}
