import { setTimeout as delay } from 'node:timers/promises';
import { advanceReleaseCandidate, type ReleaseAdvanceReport } from './release-advance.js';
import type { GitRunner } from '../verse/git-ops.js';

export type WaitStop = 'attested' | 'published' | 'planned' | 'blocked' | 'refused' | 'unavailable' | 'timeout' | 'aborted';
export interface ReleaseAdvanceWaitReport {
  version: 1;
  stopReason: WaitStop;
  observations: number;
  latest: ReleaseAdvanceReport | null;
  actionInFlight: boolean;
}
type Action = typeof advanceReleaseCandidate;
export interface WaitOptions {
  apply?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  runner?: GitRunner;
  action?: Action;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export const MAX_TIMEOUT_MS = 3_600_000;
export const MAX_POLL_MS = 60_000;
export function validWaitDuration(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/** Serial observations; only the first may delegate the existing dispatch action. */
export async function waitForReleaseAdvance(repo: string, tag: string, opts: WaitOptions = {}): Promise<ReleaseAdvanceWaitReport> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  if (!validWaitDuration(timeoutMs, MAX_TIMEOUT_MS) || !validWaitDuration(pollMs, MAX_POLL_MS)) {
    throw new RangeError('Invalid timeout or poll interval');
  }
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const action = opts.action ?? advanceReleaseCandidate;
  const deadline = now() + timeoutMs;
  let latest: ReleaseAdvanceReport | null = null;
  let observations = 0;
  const finish = (stopReason: WaitStop, actionInFlight = false): ReleaseAdvanceWaitReport => ({ version: 1, stopReason, observations, latest, actionInFlight });
  while (true) {
    if (opts.signal?.aborted) return finish('aborted');
    if (observations && now() >= deadline) return finish('timeout');
    // The existing action has no cancellation API. Return on deadline or abort,
    // but report an unfinished action explicitly; never start another read.
    const remaining = Math.max(1, deadline - now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<'timeout' | 'aborted'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), remaining);
      onAbort = () => resolve('aborted');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
    });
    let result: ReleaseAdvanceReport | 'timeout' | 'aborted';
    try {
      result = await Promise.race([action(repo, tag, { apply: observations === 0 && opts.apply === true, runner: opts.runner }), interrupted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    }
    if (typeof result === 'string') return finish(result, true);
    latest = result;
    observations++;
    if (latest.release.state === 'published') return finish('published');
    if (latest.attestedRun) return finish('attested');
    if (latest.outcome === 'blocked' || latest.outcome === 'refused' || latest.outcome === 'unavailable') return finish(latest.outcome);
    if (opts.signal?.aborted) return finish('aborted');
    if (now() >= deadline) return finish('timeout');
    // A proposed dispatch is terminal only if there was no prior submission or pending run.
    if (latest.outcome === 'planned' && observations === 1) return finish('planned');
    try {
      await sleep(Math.min(pollMs, deadline - now()), opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) return finish('aborted');
      throw error;
    }
  }
}
