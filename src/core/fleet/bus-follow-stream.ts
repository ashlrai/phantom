/** Bounded resumable local observation only. Bodies are untrusted data, never dispatched. */
import { performance } from 'node:perf_hooks';
import { isAbsolute } from 'node:path';
import { BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxPage } from './bus-inbox.js';
import type { BusEnvelope } from './bus-envelope.js';

export const BUS_FOLLOW_MAX_DURATION_MS = 3_600_000;
export const BUS_FOLLOW_MIN_INTERVAL_MS = 100;
export const BUS_FOLLOW_MAX_INTERVAL_MS = 60_000;
export const BUS_FOLLOW_DEFAULT_INTERVAL_MS = 250;

/** Printable ASCII routing labels, same constraint as the wire token fields. */
const label = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,128}(?![\s\S])/.test(value);

export interface BusFollowRequest {
  /** Nonnegative safe cursor to resume after; 0 follows from the first retained row. */
  after: number;
  /** Bounded lifetime is mandatory: 1..3600000 milliseconds. */
  durationMs: number;
  /** Optional exact-case routing-label filter. Filtering is not authentication. */
  to?: string;
  intervalMs?: number;
  /** Selects an existing local store; never creates or mutates inbox files. */
  root?: string;
}

export function validBusFollowRequest(request: BusFollowRequest): boolean {
  return Number.isSafeInteger(request.after) && request.after >= 0 &&
    Number.isSafeInteger(request.durationMs) && request.durationMs >= 1 && request.durationMs <= BUS_FOLLOW_MAX_DURATION_MS &&
    (request.to === undefined || label(request.to)) &&
    (request.intervalMs === undefined || (Number.isSafeInteger(request.intervalMs) &&
      request.intervalMs >= BUS_FOLLOW_MIN_INTERVAL_MS && request.intervalMs <= BUS_FOLLOW_MAX_INTERVAL_MS)) &&
    (request.root === undefined || (isAbsolute(request.root) && !request.root.includes('\0')));
}

export type BusFollowRecord =
  | { type: 'message'; cursor: number; receivedAt: number; envelope: BusEnvelope }
  | { type: 'checkpoint'; cursor: number };

export type BusFollowStatus = 'expired' | 'cancelled' | 'source-unavailable' | 'output-unavailable' | 'invalid';

export interface BusFollowResult {
  status: BusFollowStatus;
  /** Greatest checkpoint the output stream accepted: the safe at-least-once resume cursor. */
  cursor: number;
  /** Message records accepted by the output stream. */
  delivered: number;
  elapsedMs: number;
}

export interface BusFollowDependencies {
  /** Resolves when the record is accepted by the output stream; throws or rejects on failure. */
  emit: (record: BusFollowRecord) => void | Promise<void>;
  list?: typeof listBusInboxAfter;
  signal?: AbortSignal;
  /** Wall clock forwarded to the reader for TTL evaluation (defaults to Date.now). */
  now?: () => number;
  /** Monotonic millisecond clock for the deadline (defaults to performance.now). */
  clock?: () => number;
}

type OkPage = Extract<BusInboxPage, { status: 'ok' }>;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted || ms <= 0) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A page must report a non-regressing scan position over strictly ordered rows. */
function sanePage(page: OkPage, cursor: number): boolean {
  return Number.isSafeInteger(page.nextCursor) && page.nextCursor >= cursor &&
    page.messages.length <= BUS_INBOX_MAX_READ &&
    page.messages.every((row, index) => !!row &&
      Number.isSafeInteger(row.cursor) && row.cursor <= page.nextCursor &&
      row.cursor > (index === 0 ? cursor : page.messages[index - 1]!.cursor) &&
      Number.isSafeInteger(row.receivedAt) && row.receivedAt >= 0);
}

/** Polls the retained local inbox until the duration expires, emitting each live
 * matching receipt once and a checkpoint whenever the scan position advances.
 * A checkpoint is offered only after every preceding message record was
 * accepted, so the returned cursor is always a safe at-least-once resume point.
 * Retryable contention is retried within the deadline; unavailable, invalid or
 * malformed pages fail closed without emitting a falsely advanced checkpoint. */
export async function followBusStream(request: BusFollowRequest, deps: BusFollowDependencies): Promise<BusFollowResult> {
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  if (!validBusFollowRequest(request) || typeof deps.emit !== 'function') {
    return { status: 'invalid', cursor: 0, delivered: 0, elapsedMs: Math.max(0, Math.floor(clock() - started)) };
  }
  const deadline = started + request.durationMs;
  const interval = request.intervalMs ?? BUS_FOLLOW_DEFAULT_INTERVAL_MS;
  const list = deps.list ?? listBusInboxAfter;
  const options = { root: request.root, now: deps.now };
  const emit = async (record: BusFollowRecord): Promise<boolean> => {
    try { await deps.emit(record); return true; } catch { return false; }
  };
  const aborted = (): boolean => deps.signal?.aborted === true;
  const pause = (): Promise<void> => wait(Math.max(0, Math.min(interval, deadline - clock())), deps.signal);
  let cursor = request.after, delivered = 0, status: BusFollowStatus = 'expired';
  try {
    for (;;) {
      if (aborted()) { status = 'cancelled'; break; }
      if (clock() >= deadline) break;
      const page = list(cursor, BUS_INBOX_MAX_READ, options);
      if (aborted()) { status = 'cancelled'; break; }
      if (page.status === 'retryable') { await pause(); continue; }
      if (page.status !== 'ok' || !sanePage(page, cursor)) { status = 'source-unavailable'; break; }
      let accepted = true;
      for (const row of page.messages) {
        if (request.to !== undefined && row.envelope.to !== request.to) continue;
        if (!(await emit({ type: 'message', cursor: row.cursor, receivedAt: row.receivedAt, envelope: row.envelope }))) {
          status = aborted() ? 'cancelled' : 'output-unavailable';
          accepted = false;
          break;
        }
        delivered += 1;
      }
      if (!accepted) break;
      if (page.nextCursor > cursor) {
        const next = page.nextCursor;
        if (!(await emit({ type: 'checkpoint', cursor: next }))) {
          status = aborted() ? 'cancelled' : 'output-unavailable';
          break;
        }
        cursor = next;
      }
      if (page.messages.length === BUS_INBOX_MAX_READ) continue;
      await pause();
    }
  } catch { status = 'source-unavailable'; }
  if (status === 'expired' && !(await emit({ type: 'checkpoint', cursor }))) status = 'output-unavailable';
  return { status, cursor, delivered, elapsedMs: Math.max(0, Math.floor(clock() - started)) };
}
