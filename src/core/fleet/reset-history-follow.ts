/**
 * reset-history-follow — bounded read-only follower for the reset-release
 * audit (<runsDir>/queue/reset-releases.jsonl) while the desktop is closed.
 * It reuses the readResetReleases tail read behind `fleet reset-history` and
 * emits each newly recorded release — `at` strictly newer than the exclusive
 * watermark (default: invocation time) — with the same public fields, then one
 * terminal summary. Dedupe lives in a bounded in-memory set so identical
 * records never repeat while distinct lanes sharing a timestamp still flow.
 * The capped tail source can scroll releases out between polls — the stream
 * may have gaps; not durable exactly-once.
 */
import { abortableSleep, isAwaitMs } from './needs-mason-answer-await.js';
import { readResetReleases, type ResetReleaseRecord } from './usage-reset-release.js';

/** Finite caps keep an unattended follow bounded: 24 h overall, 1 h between reads. */
export const RESET_FOLLOW_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const RESET_FOLLOW_MAX_POLL_MS = 60 * 60 * 1000;
export const RESET_FOLLOW_DEFAULT_POLL_MS = 60_000;
/** The reader's own cap and the dedupe-set bound (oldest half evicted when full). */
const READ_CAP = 200;
export const RESET_FOLLOW_SEEN_CAP = 4096;
export const RESET_FOLLOW_SOURCE_LIMIT =
  'capped audit tail — releases can scroll out between polls, so history may have gaps; not durable exactly-once';

export type ResetFollowOutcome = 'deadline' | 'cancelled' | 'failed';
export type ResetFollowRecord =
  // release carries the same public fields `fleet reset-history` prints.
  | { v: 1; type: 'release'; lane: string | null; at: string | null;
      state: ResetReleaseRecord['state']; usedPct: number | null;
      readingAsOf: string | null; heldUntil: string | null }
  | { v: 1; type: 'end'; outcome: ResetFollowOutcome; reads: number; emitted: number;
      lastError: string | null; watermark: string; sourceLimit: string; inFlight?: true };
/** The emitted release fields, before the v/type envelope. */
type PublicRow = Omit<Extract<ResetFollowRecord, { type: 'release' }>, 'v' | 'type'>;
export interface ResetFollowResult
  { outcome: ResetFollowOutcome | 'invalid'; reads: number; emitted: number; lastError: string | null; inFlight?: true }
export interface ResetFollowOptions {
  /** 1..RESET_FOLLOW_MAX_TIMEOUT_MS. */ timeoutMs: number;
  /** 1..RESET_FOLLOW_MAX_POLL_MS, default 60 s. */ pollMs?: number;
  /** Exclusive ISO watermark: only releases with a newer `at` emit. Default invocation time. */
  after?: string;
  /** Emit only this lane's releases. */ lane?: string;
  runsDir?: string;
  signal?: AbortSignal;
}
export interface ResetFollowDeps {
  read?: typeof readResetReleases;
  /** A throw or rejection ends the follow as failed. */
  emit?: (record: ResetFollowRecord) => void | Promise<void>;
  /** Monotonic ms for the shared deadline; wall ms for the default watermark. */
  now?: () => number; wallNow?: () => number;
  /** Resolves after ms or on signal abort; must not reject. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** Same redaction the history CLI applies: audit strings are untrusted display data. */
const clean = (value: string | null): string | null =>
  value?.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]') ?? null;
const publicRow = (row: ResetReleaseRecord): PublicRow => ({
  lane: clean(row.lane), at: clean(row.at), state: row.state,
  usedPct: row.usedPct, readingAsOf: clean(row.readingAsOf), heldUntil: clean(row.heldUntil),
});

export async function followResetReleases(options: ResetFollowOptions,
    deps: ResetFollowDeps = {}): Promise<ResetFollowResult> {
  const { timeoutMs, pollMs = RESET_FOLLOW_DEFAULT_POLL_MS, after, lane, runsDir, signal } = options;
  const watermarkMs = after === undefined ? (deps.wallNow ?? (() => Date.now()))() : Date.parse(after);
  if (!isAwaitMs(timeoutMs, RESET_FOLLOW_MAX_TIMEOUT_MS) || !isAwaitMs(pollMs, RESET_FOLLOW_MAX_POLL_MS)
      || !Number.isFinite(watermarkMs)) {
    return { outcome: 'invalid', reads: 0, emitted: 0, lastError: null };
  }
  const watermark = new Date(watermarkMs).toISOString();
  const read = deps.read ?? readResetReleases;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const emit = async (record: ResetFollowRecord): Promise<boolean> =>
    { try { await deps.emit?.(record); return true; } catch { return false; } };
  const seen = new Set<string>();
  const remember = (row: PublicRow): boolean => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    if (seen.size >= RESET_FOLLOW_SEEN_CAP) {
      for (const oldest of seen) { seen.delete(oldest); if (seen.size <= RESET_FOLLOW_SEEN_CAP / 2) break; }
    }
    seen.add(key);
    return true;
  };
  let outcome: ResetFollowOutcome = 'deadline';
  let reads = 0, emitted = 0, lastError: string | null = null;
  const fail = (why: string): void => { outcome = 'failed'; lastError = why; };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = now() + timeoutMs;
  let inFlight = false;
  let wake!: (reason: 'deadline' | 'cancelled') => void;
  const stopped = new Promise<'deadline' | 'cancelled'>(resolve => { wake = resolve; });
  const onAbort = (): void => wake('cancelled');
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const timer = setTimeout(() => wake('deadline'), timeoutMs);
  // Promise.race observes late fulfillment and rejection without processing them.
  const wait = async <T>(work: Promise<T>): Promise<{ value: T } | { stopped: 'deadline' | 'cancelled' }> => {
    if (controller.signal.aborted || now() >= deadline) {
      void work.catch(() => undefined);
      return { stopped: controller.signal.aborted ? 'cancelled' : 'deadline' };
    }
    const result = await Promise.race([work.then(value => ({ value })), stopped.then(reason => ({ stopped: reason }))]);
    if ('stopped' in result) return result;
    if (controller.signal.aborted) return { stopped: 'cancelled' };
    if (now() >= deadline) return { stopped: 'deadline' };
    return result;
  };
  try {
    for (;;) {
      if (controller.signal.aborted) { outcome = 'cancelled'; break; }
      if (now() >= deadline) break;
      let rows: ResetReleaseRecord[];
      try {
        inFlight = true;
        const pending = await wait(Promise.resolve().then(() => read(runsDir, READ_CAP)));
        if ('stopped' in pending) { outcome = pending.stopped; break; }
        inFlight = false;
        rows = pending.value;
      } catch (error) { inFlight = false; fail(message(error)); break; }
      reads += 1;
      // Reader order is newest-first; emit oldest-first so a consumer's next
      // --after watermark misses as little as possible.
      const fresh: PublicRow[] = [];
      for (const row of rows) {
        if (lane !== undefined && row.lane !== lane) continue;
        const atMs = Date.parse(row.at);
        if (!Number.isFinite(atMs) || atMs <= watermarkMs) continue;
        fresh.push(publicRow(row));
      }
      let halted = false;
      for (const row of fresh.reverse()) {
        // Dedupe at emit time: a halted batch never marks pending rows seen.
        if (!remember(row)) continue;
        const delivered = await wait(emit({ v: 1, type: 'release', ...row }));
        if ('stopped' in delivered) { outcome = delivered.stopped; halted = true; break; }
        if (!delivered.value) { fail('emit failed'); halted = true; break; }
        emitted += 1;
      }
      if (halted) break;
      const remaining = Math.min(pollMs, deadline - now());
      if (remaining <= 0) continue;
      try {
        const slept = await wait(sleep(remaining, controller.signal));
        if ('stopped' in slept) { outcome = slept.stopped; break; }
      } catch (error) {
        if (controller.signal.aborted) outcome = 'cancelled'; else fail(message(error));
        break;
      }
    }
    const summary = { outcome, reads, emitted, lastError, watermark, sourceLimit: RESET_FOLLOW_SOURCE_LIMIT,
      ...(inFlight ? { inFlight: true as const } : {}) };
    // Start terminal output even at the deadline, but never wait beyond the budget.
    await wait(emit({ v: 1, type: 'end', ...summary }));
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort(); // dispose an owned abortable sleep if it is still pending
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    signal?.removeEventListener('abort', abort);
  }
  return { outcome, reads, emitted, lastError, ...(inFlight ? { inFlight: true } : {}) };
}
