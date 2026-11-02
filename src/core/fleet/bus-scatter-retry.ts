/**
 * Selective retry of an interrupted bus-scatter fan-out: the operator supplies
 * the original batch plus the immediately previous fleet.bus-scatter.v1 or
 * fleet.bus-scatter-retry.v1 report, so a partially recovered fan-out can be
 * retried repeatedly. Rows the report marks 'replied' are retained without
 * reposting and every other live original envelope passes through unchanged.
 * The report selects what to retry and is never execution or completion
 * authority: reposted envelopes keep their exact IDs and TTLs so transport
 * dedupe and reply correlation are untouched, and each retried envelope's
 * remaining lifetime is bound to validated prior post evidence so a stale
 * report never extends expired request life. Every emitted report carries
 * cumulative per-request evidence covering the original batch exactly, so a
 * retry report feeds the next retry and a later report's file mtime never
 * refreshes a TTL.
 */
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { type BusEnvelope } from './bus-envelope.js';
import { listBusInboxAfter, type BusInboxOptions } from './bus-inbox.js';
import { BUS_SCATTER_INTERVAL_MS, scatterBusRequests, type BusScatterReport, type BusScatterRow,
  type ScatterDependencies, type ScatterRowOutcome, type ScatterStatus } from './bus-scatter-request.js';

export const BUS_SCATTER_RETRY_MAX_REPORT_BYTES = 2 * 1024 * 1024;

const ROW_OUTCOMES = new Set<string>([
  'replied', 'timeout', 'cancelled', 'post-refused', 'source-unavailable', 'invalid-input', 'not-attempted',
]);
/** Evidence may additionally carry 'expired': life already proven exhausted in an earlier generation. */
const EVIDENCE_OUTCOMES = new Set<string>([...ROW_OUTCOMES, 'expired']);

/**
 * Post evidence for one request. 'posted' binds to a verifiable inbox cursor;
 * 'none' means never posted; 'unknown' is claimed but unverifiable. `at` is the
 * earliest wall-clock bound for the evidenced post, fixed by the report that
 * first proved it and carried verbatim — never re-derived from a later mtime.
 */
export type BusScatterRetryEvidencePost =
  | { status: 'posted'; cursor: number; at?: number }
  | { status: 'none' }
  | { status: 'unknown'; at?: number };

type PriorPost = BusScatterRetryEvidencePost;

/** Cumulative selection evidence for one original batch request. */
export interface BusScatterRetryEvidenceRow {
  id: string;
  from: string;
  to: string;
  priority: BusEnvelope['priority'];
  ttl: number;
  /** Latest known outcome; 'expired' marks life already proven exhausted. */
  outcome: ScatterRowOutcome | 'expired';
  /** Required while pending; informational once replied or expired. */
  post?: BusScatterRetryEvidencePost;
}

export interface BusScatterRetryReport extends Omit<BusScatterReport, 'schema' | 'counts'> {
  schema: 'fleet.bus-scatter-retry.v1';
  /** Prior-replied request IDs kept without reposting. */
  retained: string[];
  /** Request IDs whose exact original envelopes were (or would be) reposted. */
  retried: string[];
  /** Refused: no validated timestamp proves unexpired life. */
  expired: string[];
  counts: { total: number; retained: number; retried: number; replied: number; expired: number };
  /** One cumulative evidence row per original batch request — the chainable selection record. */
  evidence: BusScatterRetryEvidenceRow[];
}

interface PriorEvidence { envelope: BusEnvelope; outcome: string; post: PriorPost }
interface PendingRow { envelope: BusEnvelope; post: PriorPost }

export interface BusScatterRetrySelection {
  retained: BusEnvelope[];
  pending: PendingRow[];
  /** Rows already proven expired; carried so emitted evidence stays cumulative. */
  expired: BusEnvelope[];
  /** Latest evidence for every batch request, keyed by id, in report order. */
  prior: ReadonlyMap<string, PriorEvidence>;
}

export type BusScatterRetryParse = { ok: true; selection: BusScatterRetrySelection } | { ok: false };

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const field = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;

/** Classify a row's claimed post receipt: usable post cursor, never posted, or unverifiable. */
function priorPost(row: Record<string, unknown>, outcome: string, id: string, at: number | undefined): PriorPost {
  const result = field(row, 'result');
  if (!plain(result)) return outcome === 'not-attempted' ? { status: 'none' } : { status: 'unknown', at };
  const receipt = field(result, 'receipt');
  if (!plain(receipt)) return { status: 'unknown', at };
  const status = field(receipt, 'status'), cursor = field(receipt, 'cursor');
  if (status !== 'posted' && status !== 'duplicate') return { status: 'none' };
  return field(receipt, 'id') === id && Number.isSafeInteger(cursor) && (cursor as number) >= 1
    ? { status: 'posted', cursor: cursor as number, at } : { status: 'unknown', at };
}

/** Strict evidence post check: 'posted' needs a usable cursor; 'unknown' needs a bound when still pending. */
function evidencePost(value: unknown, required: boolean): PriorPost | null {
  if (value === undefined) return required ? null : { status: 'none' };
  if (!plain(value)) return null;
  const rawAt = field(value, 'at');
  const at = rawAt === undefined ? undefined
    : typeof rawAt === 'number' && Number.isFinite(rawAt) ? rawAt : null;
  if (at === null) return null;
  const status = field(value, 'status');
  if (status === 'none') return { status: 'none' };
  if (status === 'unknown') return required && at === undefined ? null : { status: 'unknown', at };
  if (status === 'posted') {
    const cursor = field(value, 'cursor');
    return Number.isSafeInteger(cursor) && (cursor as number) >= 1
      ? { status: 'posted', cursor: cursor as number, at } : null;
  }
  return null;
}

/**
 * Strict selection check: the report must cover the batch exactly — one row per
 * request matching id, from, to, priority and ttl, each exactly once, each with
 * a recognized outcome and valid post evidence. A scatter report's per-attempt
 * rows carry their own receipts; a retry report must carry the cumulative
 * evidence array emitted by the previous retry — retry output without evidence
 * refuses the selection rather than guessing. The report never decides
 * anything else.
 */
export function validateBusScatterRetryReport(report: unknown, requests: BusEnvelope[],
  reportMtimeMs?: number): BusScatterRetryParse {
  if (!plain(report) || requests.length < 1) return { ok: false };
  const schema = field(report, 'schema');
  if (schema === 'fleet.bus-scatter.v1') {
    const elapsed = field(report, 'elapsedMs');
    const elapsedMs = typeof elapsed === 'number' && Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
    // Earliest possible post wall-clock for this report's claims: written at
    // mtime after a run of elapsedMs, no post predates mtime - elapsedMs.
    const at = elapsedMs !== null && typeof reportMtimeMs === 'number' && Number.isFinite(reportMtimeMs)
      ? reportMtimeMs - elapsedMs : undefined;
    return selectRows(field(report, 'requests'), requests, ROW_OUTCOMES,
      (row, envelope, outcome) => priorPost(row, outcome, envelope.id, at));
  }
  if (schema === 'fleet.bus-scatter-retry.v1') {
    return selectRows(field(report, 'evidence'), requests, EVIDENCE_OUTCOMES,
      (row, _envelope, outcome) => evidencePost(field(row, 'post'),
        outcome !== 'replied' && outcome !== 'expired'));
  }
  return { ok: false };
}

function selectRows(rows: unknown, requests: BusEnvelope[], outcomes: ReadonlySet<string>,
  postOf: (row: Record<string, unknown>, envelope: BusEnvelope, outcome: string) => PriorPost | null): BusScatterRetryParse {
  if (!Array.isArray(rows) || isProxy(rows) || rows.length !== requests.length) return { ok: false };
  const byId = new Map(requests.map(envelope => [envelope.id, envelope]));
  const seen = new Set<string>(), retained: BusEnvelope[] = [], pending: PendingRow[] = [], expired: BusEnvelope[] = [];
  const prior = new Map<string, PriorEvidence>();
  for (const row of rows) {
    if (!plain(row)) return { ok: false };
    const envelope = byId.get(field(row, 'id') as string), outcome = field(row, 'outcome');
    if (envelope === undefined || seen.has(envelope.id) ||
        field(row, 'from') !== envelope.from || field(row, 'to') !== envelope.to ||
        field(row, 'priority') !== envelope.priority || field(row, 'ttl') !== envelope.ttl ||
        typeof outcome !== 'string' || !outcomes.has(outcome)) return { ok: false };
    seen.add(envelope.id);
    const post = postOf(row, envelope, outcome);
    if (post === null) return { ok: false };
    prior.set(envelope.id, { envelope, outcome, post });
    if (outcome === 'replied') retained.push(envelope);
    else if (outcome === 'expired') expired.push(envelope);
    else pending.push({ envelope, post });
  }
  return { ok: true, selection: { retained, pending, expired, prior } };
}

/** Parse the --report payload: a prior scatter or retry report document. */
export function parseBusScatterRetryFile(text: string, requests: BusEnvelope[],
  reportMtimeMs?: number): BusScatterRetryParse {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BUS_SCATTER_RETRY_MAX_REPORT_BYTES) {
    return { ok: false };
  }
  try { return validateBusScatterRetryReport(JSON.parse(text), requests, reportMtimeMs); }
  catch { return { ok: false }; }
}

/**
 * A pending row's remaining request life in ms. A claimed post binds to the
 * live inbox receipt at its recorded cursor — same id and routing — and takes
 * the TTL the store already decremented from the validated receivedAt. With no
 * verifiable receipt the earliest possible post is bound by the evidence's own
 * carried `at` timestamp — never the current report file's mtime — and a row
 * that cannot prove unexpired life reports <= 0. A row never posted keeps its
 * full TTL.
 */
function remainingLifeMs(pending: PendingRow,
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
  if (post.at === undefined || !Number.isFinite(post.at)) return 0;
  const now = (options.now ?? Date.now)();
  return Number.isSafeInteger(now) && now >= 0 ? envelope.ttl - Math.max(0, now - post.at) : 0;
}

function partitionByLife(selection: BusScatterRetrySelection,
  list: typeof listBusInboxAfter, options: BusInboxOptions): { live: BusEnvelope[]; expired: BusEnvelope[]; granted: number } {
  const live: BusEnvelope[] = [], expired: BusEnvelope[] = [];
  let granted = Number.POSITIVE_INFINITY;
  for (const pending of selection.pending) {
    const remaining = remainingLifeMs(pending, list, options);
    if (Number.isFinite(remaining) && remaining >= 1) {
      live.push(pending.envelope);
      granted = Math.min(granted, Math.floor(remaining));
    } else expired.push(pending.envelope);
  }
  return { live, expired, granted };
}

/**
 * Fold a fresh attempt's post receipt into prior evidence. A receipt naming the
 * already-evidenced post keeps the original earliest bound; a genuinely new
 * post is bounded by this run's start, and a duplicate of some other live row
 * is bounded by the earliest receipt time still consistent with it being live
 * (now - ttl). Receipts that prove nothing leave prior evidence untouched.
 */
function mergePost(prior: PriorPost, result: unknown, now: number | undefined,
  runStart: number | undefined, ttl: number): PriorPost {
  if (!plain(result)) return prior;
  const receipt = field(result, 'receipt');
  if (!plain(receipt)) return prior;
  const status = field(receipt, 'status'), cursor = field(receipt, 'cursor');
  if ((status !== 'posted' && status !== 'duplicate') ||
      !Number.isSafeInteger(cursor) || (cursor as number) < 1) return prior;
  if (prior.status === 'posted' && prior.cursor === cursor) return prior;
  const at = status === 'posted' ? runStart : now === undefined ? undefined : Math.max(0, now - ttl);
  return { status: 'posted', cursor: cursor as number, at };
}

/** Cumulative evidence covering the batch exactly: prior rows merged with fresh attempts and refusals. */
function evidenceRows(selection: BusScatterRetrySelection, retried: ReadonlyMap<string, BusScatterRow>,
  expired: ReadonlySet<string>, now: number | undefined, runStart: number | undefined): BusScatterRetryEvidenceRow[] {
  const rows: BusScatterRetryEvidenceRow[] = [];
  for (const [id, prior] of selection.prior) {
    const { envelope, outcome, post } = prior, fresh = retried.get(id);
    const latest: BusScatterRetryEvidenceRow['outcome'] = expired.has(id) ? 'expired'
      : fresh !== undefined ? fresh.outcome : outcome as BusScatterRetryEvidenceRow['outcome'];
    rows.push({
      id, from: envelope.from, to: envelope.to, priority: envelope.priority, ttl: envelope.ttl,
      outcome: latest,
      post: fresh !== undefined ? mergePost(post, fresh.result, now, runStart, envelope.ttl) : post,
    });
  }
  return rows;
}

function buildReport(mode: 'preview' | 'apply', status: ScatterStatus, concurrency: number, timeoutMs: number,
  startedAt: number, retained: BusEnvelope[], retried: BusEnvelope[], expired: BusEnvelope[],
  rows: BusScatterRow[], evidence: BusScatterRetryEvidenceRow[]): BusScatterRetryReport {
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
    evidence,
  };
}

/**
 * Repost every still-live unreplied envelope under one shared deadline capped
 * by the shortest remaining life; expired rows are refused instead of granted a
 * new lifetime and stay refused in the emitted evidence. A fully retained batch
 * is a successful no-op with zero posts.
 */
export async function retryBusScatter(selection: BusScatterRetrySelection,
  timeoutMs: number, concurrency: number, options: BusInboxOptions = {},
  deps: ScatterDependencies = {}): Promise<BusScatterRetryReport> {
  const start = deps.startedAt ?? performance.now();
  const { live, expired, granted } = partitionByLife(selection, deps.list ?? listBusInboxAfter, options);
  const allExpired = [...selection.expired, ...expired];
  const expiredIds = new Set(allExpired.map(envelope => envelope.id));
  if (live.length === 0) {
    return buildReport('apply', deps.signal?.aborted ? 'cancelled' : allExpired.length === 0 ? 'all-replied' : 'partial',
      concurrency, Math.min(timeoutMs, granted), start, selection.retained, [], allExpired, [],
      evidenceRows(selection, new Map(), expiredIds, undefined, undefined));
  }
  const timeout = Math.min(timeoutMs, granted);
  const run = await scatterBusRequests(live, timeout, concurrency, options, deps);
  const status: ScatterStatus = run.status === 'cancelled' || run.status === 'invalid-input' ? run.status
    : allExpired.length === 0 && run.requests.every(row => row.outcome === 'replied') ? 'all-replied' : 'partial';
  // The run's own posts are bounded by its wall-clock start: now - elapsed.
  const end = (options.now ?? Date.now)();
  const now = Number.isSafeInteger(end) && end >= 0 ? end : undefined;
  const runStart = now === undefined ? undefined : Math.max(0, now - run.elapsedMs);
  return buildReport('apply', status, concurrency, timeout, start, selection.retained, live, allExpired, run.requests,
    evidenceRows(selection, new Map(run.requests.map(row => [row.id, row])), expiredIds, now, runStart));
}

/** Preview the validated selection and the granted wait; no posts, no outcomes yet. */
export function previewBusScatterRetry(selection: BusScatterRetrySelection,
  timeoutMs: number, concurrency: number, options: BusInboxOptions = {},
  deps: Pick<ScatterDependencies, 'list' | 'startedAt'> = {}): BusScatterRetryReport {
  const start = deps.startedAt ?? performance.now();
  const { live, expired, granted } = partitionByLife(selection, deps.list ?? listBusInboxAfter, options);
  const allExpired = [...selection.expired, ...expired];
  const expiredIds = new Set(allExpired.map(envelope => envelope.id));
  return buildReport('preview', 'preview', concurrency, Math.min(timeoutMs, granted), start,
    selection.retained, live, allExpired, [],
    evidenceRows(selection, new Map(), expiredIds, undefined, undefined));
}
