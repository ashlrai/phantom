/**
 * Shared primitives for the fleet's bounded, observe-only wait loops: a
 * resolve-on-abort sleep, a process/caller cancellation wiring, a positive
 * millisecond bound check and a deadline/cancellation race. These were copied
 * across the *-await modules with small divergences; one implementation keeps
 * listener cleanup and late-settle handling identical everywhere.
 *
 * Every helper is cancellation-total by contract: abortableSleep and the
 * monitor inside boundedAwait never reject, so a poll loop's own try/catch
 * only ever sees operation failures.
 */
import { performance } from 'node:perf_hooks';

/** True for a positive safe integer no larger than max. */
export const isAwaitMs = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

/** Sleep seam for bounded waits: resolves after ms or as soon as the signal aborts; must not reject. */
export type AwaitSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Wire SIGINT, SIGTERM and an optional caller signal to controller.abort().
 * Returns a detach that aborts the controller — releasing an in-flight
 * abortableSleep it owns — and removes every listener this call installed.
 */
export function wireAwaitCancel(controller: AbortController, signal?: AbortSignal): () => void {
  const cancel = (): void => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return (): void => {
    controller.abort();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    signal?.removeEventListener('abort', cancel);
  };
}

export type BoundedAwaitOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'deadline' | 'cancelled' }
  | { kind: 'failed'; error?: unknown };

export interface BoundedAwaitOptions {
  /** Its abort wins the race as 'cancelled'. */
  cancel: AbortSignal;
  /** Absolute deadline on the `now` clock; expiry wins as 'deadline'. */
  deadlineMs: number;
  /** Monotonic milliseconds; defaults to performance.now(). */
  now?: () => number;
  /** Slice timer; resolves after ms or on its own signal's abort; must not reject. */
  sleep?: AwaitSleep;
  /**
   * Optional stop probe polled between sleep slices; 'cancelled' or 'failed'
   * wins the race. Without it the deadline is enforced by one uninterrupted
   * sleep of the remaining time — a watch is what makes the monitor poll.
   */
  watch?: () => 'cancelled' | 'failed' | undefined;
  /** Longest sleep between watch probes, so a stop lands within this bound. */
  watchSliceMs?: number;
}

/**
 * Race an operation against cancellation and the remaining deadline.
 * Promise.race attaches rejection handlers even to a loser that settles late,
 * so a hung reader cannot make the race reject after it has already decided.
 */
export async function boundedAwait<T>(operation: () => Promise<T>,
    options: BoundedAwaitOptions): Promise<BoundedAwaitOutcome<T>> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? abortableSleep;
  const timer = new AbortController();
  let onAbort: () => void = () => {};
  const cancelled = new Promise<{ kind: 'cancelled' }>(resolve => {
    onAbort = () => resolve({ kind: 'cancelled' });
    options.cancel.addEventListener('abort', onAbort, { once: true });
    if (options.cancel.aborted) onAbort();
  });
  // The monitor owns the deadline: with no watch it sleeps the remainder in
  // one call; with a watch it wakes each slice to re-check the stop probe.
  const monitor = async (): Promise<{ kind: 'deadline' | 'cancelled' } | { kind: 'failed'; error?: unknown }> => {
    if (options.watch === undefined) {
      try { await sleep(Math.max(0, options.deadlineMs - now()), timer.signal); }
      catch (error) { return { kind: 'failed', error }; }
      return { kind: 'deadline' };
    }
    const sliceMs = options.watchSliceMs ?? 250;
    while (!timer.signal.aborted) {
      const remaining = options.deadlineMs - now();
      if (remaining <= 0) return { kind: 'deadline' };
      try { await sleep(Math.min(sliceMs, remaining), timer.signal); }
      catch (error) { return { kind: 'failed', error }; }
      if (timer.signal.aborted) return { kind: 'failed' };
      if (now() >= options.deadlineMs) return { kind: 'deadline' };
      let stop: 'cancelled' | 'failed' | undefined;
      try { stop = options.watch(); } catch (error) { return { kind: 'failed', error }; }
      if (stop) return { kind: stop };
    }
    return { kind: 'failed' };
  };
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(value => ({ kind: 'value' as const, value }), (error) => ({ kind: 'failed' as const, error })),
      monitor(),
      cancelled,
    ]);
  } finally { timer.abort(); options.cancel.removeEventListener('abort', onAbort); }
}
