/**
 * self-tick-await.ts — bounded, read-only wait for proof a NEW self-tick pass
 * actually ran (Nov 1 actually-running / unattended-restart orders). An
 * installed timer or a stale self-tick-last.json is not evidence of work:
 * poll the existing record via readSelfTickLast until one STRICTLY newer than
 * `afterMs` — and not future-dated against this clock — shows mode=apply +
 * state=ran: 'succeeded' with no failed steps, 'failed' with step names. Old,
 * dry-run, busy, missing and unreadable records never satisfy; the deadline
 * yields 'timed-out', abort 'interrupted' — each with the last observation.
 * Never spawns, loads services, takes locks, writes or triggers a tick.
 */
import { readSelfTickLast, type SelfTickLastView } from './self-tick-last.js';

export const SELF_TICK_AWAIT_MAX_TIMEOUT_MS = 3_600_000,
  SELF_TICK_AWAIT_MAX_INTERVAL_MS = 60_000, SELF_TICK_AWAIT_DEFAULT_INTERVAL_MS = 1_000;
const MAX_FAILED_STEPS = 8, MAX_STEP_NAME = 120; // bounded-output caps for failed-step names

export type SelfTickAwaitObservation =
  | { state: 'missing' }
  | { state: 'unreadable' }
  | {
      state: 'seen'; at: string; mode: 'apply' | 'dry-run'; ranState: 'ran' | 'busy';
      failedSteps: string[];
      /** `at` strictly postdates --after / is ahead of this clock (never proof of work). */
      newerThanAfter: boolean; futureDated: boolean;
    };

export type SelfTickAwaitOutcome = 'succeeded' | 'failed' | 'timed-out' | 'interrupted';

export interface SelfTickAwaitReport {
  v: 1; outcome: SelfTickAwaitOutcome;
  after: string;      // normalized --after instant the record must strictly postdate
  deadlineAt: string; waitedMs: number; polls: number;
  /** Latest poll; on succeeded/failed it IS the concluding new apply record. */
  lastObservation: SelfTickAwaitObservation | null;
  exitCode: 0 | 1 | 3 | 130; // 0 succeeded, 1 failed, 3 timed-out, 130 interrupted (2 = usage)
}

export interface SelfTickAwaitOptions {
  /** Resolved absolute runs dir; queue/self-tick-last.json is read under it. */
  runsDir: string;
  /** ms epoch a satisfying record must strictly postdate. */
  afterMs: number;
  timeoutMs: number; intervalMs: number;
  now?: () => number;
  /** Last-record seam; defaults to readSelfTickLast. May be async. */
  read?: (runsDir: string, now: number) => SelfTickLastView | null | Promise<SelfTickLastView | null>;
  /** Sleep seam; each call is capped to the remaining deadline. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Cancellation seam; the CLI wires SIGINT/SIGTERM into it. */
  signal?: AbortSignal;
}

const capNames = (names: string[]): string[] =>
  names.slice(0, MAX_FAILED_STEPS).map((name) => name.slice(0, MAX_STEP_NAME));

const observe = (view: SelfTickLastView | null, afterMs: number, atNow: number): SelfTickAwaitObservation => {
  if (view === null) return { state: 'missing' };
  if (view.state === 'unreadable') return { state: 'unreadable' };
  const atMs = Date.parse(view.at); // readSelfTickLast only returns a parseable at
  return { state: 'seen', at: view.at, mode: view.mode, ranState: view.ranState,
    failedSteps: capNames(view.failedSteps), newerThanAfter: atMs > afterMs, futureDated: atMs > atNow };
};

/** Bound a seam by the deadline and interruption, observing late rejection safely. */
function bounded<T>(pending: Promise<T>, signal: AbortSignal, remaining: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    const stop = () => { cleanup(); resolve(undefined); };
    const timer = setTimeout(stop, Math.max(0, remaining));
    pending.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function awaitSelfTick(options: SelfTickAwaitOptions): Promise<SelfTickAwaitReport> {
  const now = options.now ?? Date.now;
  const read = options.read ?? ((dir: string, at: number) => readSelfTickLast(dir, at));
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal ?? new AbortController().signal;
  const started = now();
  const deadline = started + options.timeoutMs;
  let polls = 0, outcome: SelfTickAwaitOutcome | undefined,
    lastObservation: SelfTickAwaitObservation | null = null;

  // Sequential by construction: each read is awaited before the next poll, so
  // no two readers ever overlap and no observation history is retained.
  while (outcome === undefined) {
    if (now() >= deadline) { outcome = 'timed-out'; break; }
    if (signal.aborted) { outcome = 'interrupted'; break; }
    polls += 1;
    let stopped = false;
    try {
      // .then routes a sync-throwing seam into the same 'unreadable' path.
      const view = await bounded(Promise.resolve().then(() => read(options.runsDir, now())), signal, deadline - now());
      if (view === undefined) stopped = true;
      else lastObservation = observe(view, options.afterMs, now());
    } catch {
      lastObservation = { state: 'unreadable' };
    }
    if (now() >= deadline) { outcome = 'timed-out'; break; }
    if (stopped || signal.aborted) { outcome = signal.aborted ? 'interrupted' : 'timed-out'; break; }
    const seen = lastObservation;
    if (seen?.state === 'seen' && seen.newerThanAfter && !seen.futureDated
      && seen.mode === 'apply' && seen.ranState === 'ran') {
      outcome = seen.failedSteps.length === 0 ? 'succeeded' : 'failed';
      break;
    }
    const remaining = deadline - now();
    if (remaining <= 0) { outcome = 'timed-out'; break; }
    // The sleep is capped to the deadline so a slow interval never overshoots it.
    const slept = await bounded(sleep(Math.min(options.intervalMs, remaining), signal).then(() => true), signal, remaining);
    if (slept === undefined) { outcome = signal.aborted ? 'interrupted' : 'timed-out'; break; }
  }

  return {
    v: 1, outcome,
    after: new Date(options.afterMs).toISOString(),
    deadlineAt: new Date(deadline).toISOString(),
    waitedMs: Math.max(0, now() - started),
    polls, lastObservation,
    exitCode: ({ succeeded: 0, failed: 1, 'timed-out': 3, interrupted: 130 } as const)[outcome],
  };
}
