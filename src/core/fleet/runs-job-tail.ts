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
import { jobControlAvailability, type JobControlAvailability } from './job-control-types.js';
import { parseJobLedgerEvents, rowJob } from './runs-job-activity.js';
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
  /** `repo` and `tokens` come from this job's ledger rows; null when no row says. */
  detail: Pick<FleetJobDetailV1, 'state' | 'lane' | 'tier' | 'model' | 'launchedAt'> & { prUrl: string | null; repo: string | null; tokens: number | null };
  /** Whether pause, stop and move can reach this job from here, with a plain reason when not. */
  controls: JobControlAvailability;
  events: FleetJobTailEvent[];
  truncated: boolean;
  /** Byte offsets follow mode resumes from; null when that file is absent. */
  cursor: { log: number | null; ledger: number | null };
}

export interface FleetJobTailOptions {
  runsDir?: string;
  /** Last N log lines (1..200, default 40) and at most N ledger events. */
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

const MAX_LINES = 200;
const LEDGER_BYTES = 512 * 1024;
const FOLLOW_CHUNK = 256 * 1024;
const LOG_BYTES = 128 * 1024;

const ledgerPath = (runsDir: string) => join(runsDir, 'metrics', 'jobs.jsonl');
const resolveRunsDir = (runsDir?: string): string => {
  const dir = runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new Error('runsDir must be an absolute path');
  return dir;
};

/** One descriptor supplies both the size and the bytes. Null offset selects a tail window. */
export async function readWindow(path: string, offset: number | null, max: number) {
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

/** Repo and worker-reported token total from this job's ledger rows; the newest row that says wins. */
function ledgerFacts(text: string, job: string): { repo: string | null; tokens: number | null } {
  const facts: { repo: string | null; tokens: number | null } = { repo: null, tokens: null };
  for (const line of text.split('\n')) {
    if (!line.includes(job)) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof row !== 'object' || row === null || rowJob(row) !== job) continue;
    if (typeof row['repo'] === 'string' && row['repo'] !== '') facts.repo = row['repo'].slice(0, 120);
    const tokens = row['tokens_total'];
    if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) facts.tokens = tokens;
  }
  return facts;
}

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
  const facts = ledgerFacts(ledgerText, job);
  return {
    schema: 'fleet.job.tail.v1',
    generatedAt: now.toISOString(),
    job: detail.job,
    status,
    headline: redact(headline(detail)),
    message: message === null ? null : redact(message),
    detail: { state: detail.state, lane: detail.lane, tier: detail.tier, model: detail.model, launchedAt: detail.launchedAt, prUrl: detail.publish?.prUrl ?? null,
      repo: facts.repo === null ? null : redact(facts.repo), tokens: facts.tokens },
    controls: jobControlAvailability(status),
    events: [
      ...ledgerRows.map(e => ledgerEvent(e, redact)),
      ...detail.log.tail.map((text): FleetJobTailEvent => ({ ts: null, source: 'log', text: redact(text) })),
    ],
    truncated: detail.log.truncated || clipped,
    cursor: { log: log?.next ?? null, ledger: ledger ? ledger.from + ledgerEnd : null },
  };
}

export interface FleetJobLogRead {
  /** Redacted whole lines, oldest first. */
  lines: string[];
  /** Byte offset just past the last whole line returned; pass back as `after`. Null when there is no live log. */
  cursor: number | null;
  /** Earlier lines exist that are not in `lines` (snapshot reads only). */
  truncated: boolean;
  /** Whole lines past `cursor` did not fit this read; ask again right away. */
  more: boolean;
}

/**
 * Whole log lines for one job (fleet.job.window.v1's tail cursor).
 *
 * - `after` null: the last `lines` lines. `final` false (a running job) holds
 *   back an unfinished last line so the cursor never splits a line.
 * - `after` n: only whole lines written after byte n, oldest first, at most
 *   `lines` of them (`more` says when to ask again). A log shorter than n was
 *   replaced, so reading restarts at 0.
 *
 * Every line passes `redact` (default scrubJobLogLine). Never throws on fs
 * input: a missing or unreadable log reads as no lines and a null cursor.
 */
export async function readFleetJobLog(job: string, options: { runsDir?: string; after?: number | null; lines?: number; final?: boolean; redact?: (line: string) => string } = {}): Promise<FleetJobLogRead> {
  if (!isFleetJobId(job)) throw new Error('invalid fleet job id');
  const runsDir = resolveRunsDir(options.runsDir);
  const max = Math.max(1, Math.min(MAX_LINES, Math.floor(options.lines ?? 40)));
  const redact = options.redact ?? scrubJobLogLine;
  const after = options.after ?? null;
  const window = await readWindow(join(runsDir, `${job}.log`), after, after === null ? LOG_BYTES : FOLLOW_CHUNK).catch(() => null);
  if (!window) return { lines: [], cursor: null, truncated: false, more: false };
  const skip = after === null && window.from > 0 ? window.data.indexOf(0x0a) + 1 : 0;
  const lastNewline = window.data.lastIndexOf(0x0a);
  const keepPartial = after === null && options.final === true;
  const end = keepPartial ? window.data.length : lastNewline + 1;
  if (after === null && window.from > 0 && skip === 0) return { lines: [], cursor: window.next, truncated: true, more: false };
  const text = end > skip ? window.data.toString('utf8', skip, end) : '';
  const all = text === '' ? [] : text.split('\n');
  if (all.at(-1) === '') all.pop();
  if (after === null) {
    return { lines: all.slice(-max).map(redact), cursor: window.from + end, truncated: window.from > 0 || all.length > max, more: false };
  }
  // A single line longer than the read window can never complete inside it: skip past it.
  if (all.length === 0 && lastNewline === -1 && !window.drained && window.data.length >= FOLLOW_CHUNK) {
    return { lines: [redact('Log line omitted: exceeds the read limit.')], cursor: window.next, truncated: false, more: true };
  }
  if (all.length <= max) return { lines: all.map(redact), cursor: window.from + end, truncated: false, more: !window.drained && end > 0 };
  // Cut on the max-th newline byte, not on decoded text, so the cursor stays exact.
  let cut = -1;
  for (let n = 0; n < max; n++) cut = window.data.indexOf(0x0a, cut + 1);
  return { lines: all.slice(0, max).map(redact), cursor: window.from + cut + 1, truncated: false, more: true };
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
