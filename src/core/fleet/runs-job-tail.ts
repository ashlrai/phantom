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
 * snapshot cursor, through no-follow regular-file descriptors, bounded per tick.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describeJob, type JobTailStatus } from './job-tail-words.js';
import { parseJobLedgerEvents } from './runs-job-activity.js';
import { getFleetJobDetail, isFleetJobId, scrubJobLogLine, type FleetJobDetailV1 } from './runs-job-detail.js';

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
const LOG_BYTES = 32 * 1024;

const ledgerPath = (runsDir: string) => join(runsDir, 'metrics', 'jobs.jsonl');
const resolveRunsDir = (runsDir?: string): string => {
  const dir = runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new Error('runsDir must be an absolute path');
  return dir;
};

/** One descriptor supplies both the size and the bytes. Null offset selects a tail window. */
async function readWindow(path: string, offset: number | null, max: number) {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('invalid tail source');
    const reset = offset !== null && st.size < offset;
    const from = offset === null ? Math.max(0, st.size - max) : reset ? 0 : offset;
    const length = Math.min(st.size - from, max);
    const buf = Buffer.alloc(length);
    let bytes = 0;
    while (bytes < length) {
      const { bytesRead } = await fh.read(buf, bytes, length - bytes, from + bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    return { data: buf.subarray(0, bytes), from, next: from + bytes, reset, drained: from + bytes >= st.size || bytes < length };
  } finally { await fh.close(); }
}

function snapshotText(window: Awaited<ReturnType<typeof readWindow>>): string {
  const start = window.from > 0 ? window.data.indexOf(0x0a) + 1 : 0;
  return window.from > 0 && start === 0 ? '' : window.data.toString('utf8', start);
}

/** Retain partial UTF-8 lines across ticks, but never retain an unbounded line. */
function lineBuffer() {
  let pending: Buffer = Buffer.alloc(0);
  let oversized = false;
  return (data: Buffer, reset = false, final = false): (string | null)[] => {
    if (reset) { pending = Buffer.alloc(0); oversized = false; }
    const buffer = Buffer.concat([pending, data]);
    const lines: (string | null)[] = [];
    let start = 0;
    let end: number;
    while ((end = buffer.indexOf(0x0a, start)) !== -1) {
      lines.push(oversized || end - start > FOLLOW_CHUNK ? null : buffer.toString('utf8', start, end));
      oversized = false;
      start = end + 1;
    }
    pending = buffer.subarray(start);
    if (pending.length > FOLLOW_CHUNK) { oversized = true; pending = Buffer.alloc(0); }
    if (oversized) pending = Buffer.alloc(0);
    if (final && (pending.length || oversized)) {
      lines.push(oversized ? null : pending.toString('utf8'));
      pending = Buffer.alloc(0); oversized = false;
    }
    return lines;
  };
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
  const [detail, ledger, log] = await Promise.all([
    getFleetJobDetail(job, { runsDir, now: () => now, maxTailLines: lines, maxTailBytes: 0 }),
    readWindow(ledgerPath(runsDir), null, LEDGER_BYTES).catch(() => null),
    readWindow(join(runsDir, `${job}.log`), null, LOG_BYTES).catch(() => null),
  ]);
  if (log) {
    const text = snapshotText(log);
    const tail = text.split('\n');
    if (tail.at(-1) === '') tail.pop();
    detail.log = { source: 'live', bytes: log.next, tail: tail.slice(-lines).map(scrubJobLogLine),
      truncated: log.from > 0 || tail.length > lines };
    detail.sources.log = 'healthy';
  } else if (detail.log.source === 'live') {
    detail.log.tail = [];
    detail.sources.log = 'degraded';
  }
  const ledgerEnd = ledger ? ledger.data.lastIndexOf(0x0a) + 1 : 0;
  const ledgerText = ledger ? snapshotText({ ...ledger, data: ledger.data.subarray(0, ledgerEnd) }) : '';
  const { events: ledgerRows, clipped } = parseJobLedgerEvents(ledgerText, job, lines);
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
    cursor: { log: log?.next ?? null, ledger: ledger ? ledger.from + ledgerEnd : null },
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
  let terminalSeen = false;
  const logLines = lineBuffer();
  const ledgerLines = lineBuffer();
  const emitLog = (lines: (string | null)[], ts: string) => {
    for (const line of lines) options.onEvent({ ts, source: 'log', text: redact(line ?? 'Log line omitted: exceeds follow byte limit.') });
  };
  const emitLedger = (lines: (string | null)[]) => {
    const text = lines.filter((line): line is string => line !== null).join('\n');
    for (const e of parseJobLedgerEvents(text, job, Number.MAX_SAFE_INTEGER).events) options.onEvent(ledgerEvent(e, redact));
  };
  while (!options.signal?.aborted) {
    const ts = clock().toISOString();
    const appended = await readWindow(join(runsDir, `${job}.log`), log, FOLLOW_CHUNK).catch(() => null);
    if (appended) {
      log = appended.next;
      emitLog(logLines(appended.data, appended.reset), ts);
    }
    const rows = await readWindow(ledgerPath(runsDir), ledger, FOLLOW_CHUNK).catch(() => null);
    if (rows) {
      ledger = rows.next;
      emitLedger(ledgerLines(rows.data, rows.reset));
    }
    const detail = await getFleetJobDetail(job, { runsDir, now: clock, maxTailLines: 1 }).catch(() => null);
    if (detail && (detail.state === 'published' || detail.state === 'archived')) {
      const confirmed = terminalSeen;
      terminalSeen = true;
      if (!confirmed || appended?.data.length || rows?.data.length || appended?.drained === false || rows?.drained === false) continue;
      emitLog(logLines(Buffer.alloc(0), false, true), ts);
      emitLedger(ledgerLines(Buffer.alloc(0), false, true));
      options.onEvent({ ts, source: 'status', text: redact(describeJob(detail, Date.parse(ts)).text ?? `Job ${job} finished.`) });
      return 'finished';
    }
    terminalSeen = false;
    if (options.signal?.aborted) break;
    await wait(intervalMs, options.signal);
  }
  return 'stopped';
}
