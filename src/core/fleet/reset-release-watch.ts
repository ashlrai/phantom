/**
 * reset-release-watch — bounded repetition of the guarded runResetReleaseOnce
 * pass while the desktop is closed: one pass now, then one per poll until the
 * deadline, the stop file appears or the caller aborts. No service, no new
 * hold policy — each pass runs the same guarded path, so the healthy-source
 * gate and releaseLaneHold's held_by recheck still decide. Cancellation lands
 * while waiting; an already started release may still finish after return.
 * Only completed passes contribute counts. The stop file is an lstat-only
 * sentinel. One 'pass' record per completed pass, one 'end' record closes it.
 */
import { lstatSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { abortableSleep, isAwaitMs } from './needs-mason-answer-await.js';
import {
  runResetReleaseOnce, type ResetReleaseResult, type RunResetReleaseOptions,
} from './usage-reset-release.js';

/** Finite caps keep an unattended watch bounded: 24 h overall, 1 h between passes. */
export const RESET_WATCH_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const RESET_WATCH_MAX_POLL_MS = 60 * 60 * 1000;
/** Matches the 60 s tick of the desktop-armed loop. */
export const RESET_WATCH_DEFAULT_POLL_MS = 60_000;
/** Longest sleep between stop-file probes, so a stop lands within this bound. */
const STOP_SLICE_MS = 250;

export type ResetWatchOutcome = 'deadline' | 'cancelled' | 'failed';
/** Per completed pass: counts, released lane names, lane errors — never raw evidence. */
export type ResetWatchRecord =
  | { v: 1; type: 'pass'; at: string; checked: number; released: number;
      lanes: string[]; errors: { lane: string; message: string }[] }
  | { v: 1; type: 'end'; outcome: ResetWatchOutcome;
      passes: number; released: number; errors: number; lastError: string | null; inFlight?: true };
export interface ResetWatchResult {
  outcome: ResetWatchOutcome | 'invalid';
  passes: number; released: number; errors: number; lastError: string | null; inFlight?: true;
}
export interface ResetWatchOptions {
  /** 1..RESET_WATCH_MAX_TIMEOUT_MS. */ timeoutMs: number;
  /** 1..RESET_WATCH_MAX_POLL_MS, default 60 s. */ pollMs?: number;
  runsDir?: string;
  /** Existence sentinel cancelling before the next pass; never read. */ stopFile?: string;
  signal?: AbortSignal;
}
export interface ResetWatchDeps {
  run?: (opts: RunResetReleaseOptions) => Promise<ResetReleaseResult>;
  /** A throw or rejection ends the watch as failed. */
  emit?: (record: ResetWatchRecord) => void | Promise<void>;
  /** Monotonic ms for the shared deadline; never forwarded to run. */ now?: () => number;
  /** Resolves after ms or on signal abort; must not reject. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 'stop' when the stop path exists, 'go' when absent, 'error' otherwise. */
  probe?: (path: string) => 'stop' | 'go' | 'error';
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** lstat only — a dangling symlink still counts as present; contents are never read. */
const probePath = (path: string): 'stop' | 'go' | 'error' => {
  try { lstatSync(path); return 'stop'; } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'go' : 'error';
  }
};
export async function watchResetReleases(options: ResetWatchOptions,
    deps: ResetWatchDeps = {}): Promise<ResetWatchResult> {
  const { timeoutMs, pollMs = RESET_WATCH_DEFAULT_POLL_MS, runsDir, stopFile, signal } = options;
  if (!isAwaitMs(timeoutMs, RESET_WATCH_MAX_TIMEOUT_MS) || !isAwaitMs(pollMs, RESET_WATCH_MAX_POLL_MS)
      || (stopFile !== undefined && (stopFile === '' || stopFile.includes('\0')))) {
    return { outcome: 'invalid', passes: 0, released: 0, errors: 0, lastError: null };
  }
  const run = deps.run ?? runResetReleaseOnce;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const probe = deps.probe ?? probePath;
  const emit = async (record: ResetWatchRecord): Promise<boolean> => {
    try { await deps.emit?.(record); return true; } catch { return false; }
  };
  let outcome: ResetWatchOutcome = 'deadline';
  let passes = 0, released = 0, errors = 0, lastError: string | null = null;
  const fail = (why: string): void => { outcome = 'failed'; lastError = why; };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  // The stop-file sentinel is checked between stages; signals interrupt awaits.
  const gate = (): ResetWatchOutcome | undefined => {
    if (controller.signal.aborted) return 'cancelled';
    if (stopFile === undefined) return undefined;
    const state = probe(stopFile);
    if (state === 'error') lastError = 'stop-file probe failed';
    return state === 'go' ? undefined : state === 'stop' ? 'cancelled' : 'failed';
  };
  const deadline = now() + timeoutMs;
  let inFlight = false;
  let wake!: (reason: 'deadline' | 'cancelled') => void;
  const stopped = new Promise<'deadline' | 'cancelled'>(resolve => { wake = resolve; });
  const onAbort = (): void => wake('cancelled');
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const timer = setTimeout(() => wake('deadline'), timeoutMs);
  // Promise.race observes both late fulfillment and rejection without processing them.
  const wait = async <T>(work: Promise<T>): Promise<
    { value: T } | { stopped: 'deadline' | 'cancelled' }
  > => {
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
      const end = gate();
      if (end || now() >= deadline) { if (end) outcome = end; break; }
      let pass: ResetReleaseResult;
      try {
        inFlight = true;
        const pending = await wait(Promise.resolve().then(() => run({ runsDir })));
        if ('stopped' in pending) { outcome = pending.stopped; break; }
        inFlight = false;
        pass = pending.value;
      } catch (error) { inFlight = false; fail(message(error)); break; }
      passes += 1;
      released += pass.released.length;
      errors += pass.errors.length;
      const emitted = await wait(emit({ v: 1, type: 'pass', at: pass.at, checked: pass.checked,
        released: pass.released.length, lanes: pass.released.map((row) => row.lane),
        errors: pass.errors }));
      if ('stopped' in emitted) { outcome = emitted.stopped; break; }
      if (!emitted.value) { fail('emit failed'); break; }
      const mid = gate();
      if (mid) { outcome = mid; break; }
      // Slices only when a stop file is watched; a stalled clock cannot spin.
      let left = Math.min(pollMs, deadline - now());
      while (left > 0) {
        const slice = stopFile === undefined ? left : Math.min(left, STOP_SLICE_MS);
        try {
          const slept = await wait(sleep(slice, controller.signal));
          if ('stopped' in slept) { outcome = slept.stopped; break; }
        } catch (error) {
          if (controller.signal.aborted) outcome = 'cancelled'; else fail(message(error));
          break;
        }
        left -= slice;
        const slept = gate();
        if (slept) { outcome = slept; break; }
      }
      if (outcome !== 'deadline') break;
    }
    const summary = { outcome, passes, released, errors, lastError, ...(inFlight ? { inFlight: true as const } : {}) };
    // Start terminal output even at the deadline, but never wait beyond the budget.
    await wait(emit({ v: 1, type: 'end', ...summary }));
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort(); // dispose an owned abortable sleep if it is still pending
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    signal?.removeEventListener('abort', abort);
  }
  return { outcome, passes, released, errors, lastError, ...(inFlight ? { inFlight: true } : {}) };
}
