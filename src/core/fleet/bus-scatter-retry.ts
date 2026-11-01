/**
 * Selective retry of an interrupted bus-scatter fan-out: the operator supplies
 * the original batch plus the previous fleet.bus-scatter.v1 report; rows the
 * report marked 'replied' are retained without reposting and every other
 * original envelope passes through unchanged. The report selects what to retry
 * and is never execution or completion authority: reposted envelopes keep
 * their exact IDs and TTLs so transport dedupe and reply correlation are
 * untouched, and each retried envelope's remaining lifetime is bound to
 * validated prior receipt timestamps so a stale report never extends expired
 * request life.
 */
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { type BusEnvelope } from './bus-envelope.js';
import { listBusInboxAfter, type BusInboxOptions } from './bus-inbox.js';
import { BUS_SCATTER_INTERVAL_MS, scatterBusRequests, type BusScatterReport, type BusScatterRow,
  type ScatterDependencies, type ScatterStatus } from './bus-scatter-request.js';

export const BUS_SCATTER_RETRY_MAX_REPORT_BYTES = 2 * 1024 * 1024;

const ROW_OUTCOMES = new Set<string>([
  'replied', 'timeout', 'cancelled', 'post-refused', 'source-unavailable', 'invalid-input', 'not-attempted',
]);

export interface BusScatterRetryReport extends Omit<BusScatterReport, 'schema' | 'counts'> {
  schema: 'fleet.bus-scatter-retry.v1';
  /** Prior-replied request IDs kept without reposting. */
  retained: string[];
  /** Request IDs whose exact original envelopes were (or would be) reposted. */
  retried: string[];
  /** Refused: no validated timestamp proves unexpired life. */
  expired: string[];
  counts: { total: number; retained: number; retried: number; replied: number; expired: number };
}

/** 'posted' = verifiable post receipt; 'none' = never posted; 'unknown' = claimed but unverifiable. */
type PriorPost = { status: 'posted'; cursor: number } | { status: 'none' | 'unknown' };

interface PendingRow { envelope: BusEnvelope; post: PriorPost }

export interface BusScatterRetrySelection {
  retained: BusEnvelope[];
  pending: PendingRow[];
  /** Recorded run length; the earliest prior post is bound by report mtime - elapsedMs. */
  elapsedMs: number | null;
}

export type BusScatterRetryParse = { ok: true; selection: BusScatterRetrySelection } | { ok: false };

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const field = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;

/** Classify a row's claimed post receipt: usable post cursor, never posted, or unverifiable. */
function priorPost(row: Record<string, unknown>, outcome: string, id: string): PriorPost {
  const result = field(row, 'result');
  if (!plain(result)) return outcome === 'not-attempted' ? { status: 'none' } : { status: 'unknown' };
  const receipt = field(result, 'receipt');
  if (!plain(receipt)) return { status: 'unknown' };
  const status = field(receipt, 'status'), cursor = field(receipt, 'cursor');
  if (status !== 'posted' && status !== 'duplicate') return { status: 'none' };
  return field(receipt, 'id') === id && Number.isSafeInteger(cursor) && (cursor as number) >= 1
    ? { status: 'posted', cursor: cursor as number } : { status: 'unknown' };
}

/**
 * Strict selection check: the report must cover the batch exactly — one row per
 * request matching id, from, to, priority and ttl, each exactly once, each with
 * a recognized outcome. Mismatched, duplicated or unknown rows refuse the whole
 * selection; the report never decides anything else.
 */
export function validateBusScatterRetryReport(report: unknown, requests: BusEnvelope[]): BusScatterRetryParse {
  if (!plain(report) || field(report, 'schema') !== 'fleet.bus-scatter.v1' ||
      requests.length < 1) return { ok: false };
  const rows = field(report, 'requests');
  if (!Array.isArray(rows) || isProxy(rows) || rows.length !== requests.length) return { ok: false };
  const elapsed = field(report, 'elapsedMs');
  const elapsedMs = typeof elapsed === 'number' && Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
  const byId = new Map(requests.map(envelope => [envelope.id, envelope]));
  const seen = new Set<string>(), retained: BusEnvelope[] = [], pending: PendingRow[] = [];
  for (const row of rows) {
    if (!plain(row)) return { ok: false };
    const envelope = byId.get(field(row, 'id') as string), outcome = field(row, 'outcome');
    if (envelope === undefined || seen.has(envelope.id) ||
        field(row, 'from') !== envelope.from || field(row, 'to') !== envelope.to ||
        field(row, 'priority') !== envelope.priority || field(row, 'ttl') !== envelope.ttl ||
        typeof outcome !== 'string' || !ROW_OUTCOMES.has(outcome)) return { ok: false };
    seen.add(envelope.id);
    if (outcome === 'replied') retained.push(envelope);
    else pending.push({ envelope, post: priorPost(row, outcome, envelope.id) });
  }
  return { ok: true, selection: { retained, pending, elapsedMs } };
}

/** Parse the --report payload: a prior fleet.bus-scatter.v1 report document. */
export function parseBusScatterRetryFile(text: string, requests: BusEnvelope[]): BusScatterRetryParse {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BUS_SCATTER_RETRY_MAX_REPORT_BYTES) {
    return { ok: false };
  }
  try { return validateBusScatterRetryReport(JSON.parse(text), requests); } catch { return { ok: false }; }
}

/**
 * A pending row's remaining request life in ms. A claimed post binds to the
 * live inbox receipt at its recorded cursor — same id and routing — and takes
 * the TTL the store already decremented from the validated receivedAt. With no
 * verifiable receipt the earliest possible post is bound by the report file's
 * own mtime minus its recorded run length; a row that cannot prove unexpired
 * life reports <= 0. A row never posted keeps its full TTL.
 */
function remainingLifeMs(pending: PendingRow, mtimeMs: number, elapsedMs: number | null,
  list: typeof listBusInboxAfter, options: BusInboxOptions): number {
  const { envelope, post } = pending;
  if (post.status === 'none') return envelope.ttl;
  if (post.status === 'posted') {
    const page = list(post.cursor - 1, 1, options);
    const row = page.status === 'ok' ? page.messages[0] : undefined;
    if (row !== undefined && row.cursor === post.cursor && row.envelope.id === envelope.id &&
        row.envelope.from === envelope.from && row.envelope.to === envelope.to &&
        row.envelope.priority === envelope.priority && Number.isSafeInteger(row.envelope.ttl)) {
      return row.envelope.ttl;
    }
  }
  if (elapsedMs === null || !Number.isFinite(mtimeMs)) return 0;
  const now = (options.now ?? Date.now)();
  return Number.isSafeInteger(now) && now >= 0 ? envelope.ttl - Math.max(0, now - mtimeMs + elapsedMs) : 0;
}

function partitionByLife(selection: BusScatterRetrySelection, mtimeMs: number,
  list: typeof listBusInboxAfter, options: BusInboxOptions): { live: BusEnvelope[]; expired: BusEnvelope[]; granted: number } {
  const live: BusEnvelope[] = [], expired: BusEnvelope[] = [];
  let granted = Number.POSITIVE_INFINITY;
  for (const pending of selection.pending) {
    const remaining = remainingLifeMs(pending, mtimeMs, selection.elapsedMs, list, options);
    if (Number.isFinite(remaining) && remaining >= 1) {
      live.push(pending.envelope);
      granted = Math.min(granted, Math.floor(remaining));
    } else expired.push(pending.envelope);
  }
  return { live, expired, granted };
}

function buildReport(mode: 'preview' | 'apply', status: ScatterStatus, concurrency: number, timeoutMs: number,
  startedAt: number, retained: BusEnvelope[], retried: BusEnvelope[], expired: BusEnvelope[],
  rows: BusScatterRow[]): BusScatterRetryReport {
  return {
    schema: 'fleet.bus-scatter-retry.v1', mode, status, correlation: 'untrusted-routing-only',
    concurrency, timeoutMs, intervalMs: BUS_SCATTER_INTERVAL_MS,
    elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
    retained: retained.map(envelope => envelope.id),
    retried: retried.map(envelope => envelope.id),
    expired: expired.map(envelope => envelope.id),
    counts: {
      total: retained.length + retried.length + expired.length,
      retained: retained.length, retried: retried.length,
      replied: rows.filter(row => row.outcome === 'replied').length, expired: expired.length,
    },
    requests: rows,
  };
}

/**
 * Repost every still-live unreplied envelope under one shared deadline capped
 * by the shortest remaining life; expired rows are refused instead of granted a
 * new lifetime. A fully retained batch is a successful no-op with zero posts.
 */
export async function retryBusScatter(selection: BusScatterRetrySelection, reportMtimeMs: number,
  timeoutMs: number, concurrency: number, options: BusInboxOptions = {},
  deps: ScatterDependencies = {}): Promise<BusScatterRetryReport> {
  const start = deps.startedAt ?? performance.now();
  const { live, expired, granted } = partitionByLife(selection, reportMtimeMs, deps.list ?? listBusInboxAfter, options);
  if (live.length === 0) {
    return buildReport('apply', deps.signal?.aborted ? 'cancelled' : expired.length === 0 ? 'all-replied' : 'partial',
      concurrency, Math.min(timeoutMs, granted), start, selection.retained, [], expired, []);
  }
  const timeout = Math.min(timeoutMs, granted);
  const run = await scatterBusRequests(live, timeout, concurrency, options, deps);
  const status: ScatterStatus = run.status === 'cancelled' || run.status === 'invalid-input' ? run.status
    : expired.length === 0 && run.requests.every(row => row.outcome === 'replied') ? 'all-replied' : 'partial';
  return buildReport('apply', status, concurrency, timeout, start, selection.retained, live, expired, run.requests);
}

/** Preview the validated selection and the granted wait; no posts, no outcomes yet. */
export function previewBusScatterRetry(selection: BusScatterRetrySelection, reportMtimeMs: number,
  timeoutMs: number, concurrency: number, options: BusInboxOptions = {},
  deps: Pick<ScatterDependencies, 'list' | 'startedAt'> = {}): BusScatterRetryReport {
  const start = deps.startedAt ?? performance.now();
  const { live, expired, granted } = partitionByLife(selection, reportMtimeMs, deps.list ?? listBusInboxAfter, options);
  return buildReport('preview', 'preview', concurrency, Math.min(timeoutMs, granted), start,
    selection.retained, live, expired, []);
}
