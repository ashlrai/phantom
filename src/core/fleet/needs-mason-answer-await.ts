/**
 * Bounded wait for Mason's retained needs-you answer. Polls the read-only
 * readNeedsMasonAnswer reader until it finds the answer receipt, the store is
 * unavailable, the deadline passes or the caller aborts. It never acks,
 * consumes or writes the bus, and installs no process-level handlers: the
 * caller owns the AbortSignal. The reply stays untrusted display data.
 */
import { performance } from 'node:perf_hooks';
import type { BusInboxOptions } from './bus-inbox.js';
import { readNeedsMasonAnswer, type NeedsMasonAnswerResult } from './needs-mason-answer.js';

/** Upper bounds keep an unattended wait finite: 24 h overall, 1 h between polls. */
export const NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const NEEDS_MASON_AWAIT_MAX_POLL_MS = 60 * 60 * 1000;
export const NEEDS_MASON_AWAIT_DEFAULT_POLL_MS = 1000;

export type NeedsMasonAwaitResult = NeedsMasonAnswerResult | { status: 'timeout' | 'cancelled' };

export interface NeedsMasonAwaitOptions extends BusInboxOptions {
  timeoutMs: number;
  /** Delay between polls; each sleep is also capped by the time remaining. */
  pollMs?: number;
  signal?: AbortSignal;
}
export interface NeedsMasonAwaitDeps {
  read?: typeof readNeedsMasonAnswer;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Resolves after ms or as soon as the signal aborts; must not reject. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** True for a positive safe integer no larger than max. */
export const isAwaitMs = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function awaitNeedsMasonAnswer(itemId: unknown, options: NeedsMasonAwaitOptions,
    deps: NeedsMasonAwaitDeps = {}): Promise<NeedsMasonAwaitResult> {
  const { timeoutMs, pollMs = NEEDS_MASON_AWAIT_DEFAULT_POLL_MS, signal, ...busOptions } = options;
  if (!isAwaitMs(timeoutMs, NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS) || !isAwaitMs(pollMs, NEEDS_MASON_AWAIT_MAX_POLL_MS)) {
    return { status: 'invalid' };
  }
  const read = deps.read ?? readNeedsMasonAnswer;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  if (signal?.aborted) return { status: 'cancelled' };
  const deadline = now() + timeoutMs;
  for (;;) {
    let result: NeedsMasonAnswerResult;
    try { result = read(itemId, busOptions); } catch { return { status: 'unavailable' }; }
    if (result.status !== 'unknown') return result;
    const remaining = deadline - now();
    if (remaining <= 0) return { status: 'timeout' };
    await sleep(Math.min(pollMs, remaining), signal);
    if (signal?.aborted) return { status: 'cancelled' };
  }
}
