/**
 * self-loop.ts — the bounded repeat driver for one self-management pass.
 * runSelfTick (self-tick.ts) runs a single locked pass; an agent that must
 * keep it running for a bounded window had to re-invoke it from an external
 * shell timer. runSelfLoop is that repetition, and only that repetition —
 * every pass is the injected tick seam (the real default is cmdFleetSelfTick,
 * so the holds policy, the queue/self-tick.lock and the dry-run semantics all
 * stay inside the existing verbs; this module implements no second policy).
 *
 * Admission is decided by the clock, never by the loop counter: the first
 * pass starts immediately, and a further pass is admitted only while the
 * clock is still before the deadline and the abort signal is silent. If the
 * abort signal is already set when runSelfLoop is called (pre-abort), the
 * loop admits no pass at all, invokes neither tick nor sleep, and returns
 * an interrupted summary with zero ticks, failures, and busy counters. A
 * pass already in flight when the deadline passes (or a signal arrives)
 * finishes normally — the loop never interrupts a tick. Sequencing is one
 * awaited tick, then one awaited sleep of the interval capped to the budget
 * left before the deadline: passes can therefore never overlap, and a window
 * shorter than the interval ends at its deadline, not one interval after it.
 * A nonzero or throwing tick ends that pass as a failure and the loop
 * continues; a tick reporting state 'busy' is counted and likewise
 * does not stop the loop.
 *
 * Two opt-in backoffs stretch the wait without changing admission. Failure
 * backoff doubles the delay per consecutive failed pass (a busy pass resets
 * it). Busy backoff, separately, doubles the delay per consecutive busy pass
 * regardless of exit code; any other outcome resets only that busy streak.
 * Each streak starts from the base interval after its own reset, so the two
 * never compound: the wait is the larger of the two current delays, and a
 * busy or failed pass leaves the other streak at zero.
 *
 * Memory is bounded by construction: the loop keeps integer counters and the
 * latest parsed report only — no history of ticks is retained. Progress is
 * reported through an optional per-pass sink (onPass) that the loop awaits
 * and then forgets; a throwing sink stops admission safely and is named in
 * the summary (termination 'observer-error') — it never crashes a tick.
 *
 * An optional integer max-ticks bound (1..1000) can be supplied alongside
 * --duration-ms: whichever bound occurs first stops admission. Default
 * behavior (no max-ticks) is unchanged.
 *
 * An explicit stop order can gate admission further: the optional checkStop
 * seam is awaited before every pass (the first included); 'stop' ends
 * admission with termination 'stop-file' and no further pass, while a
 * rejection ends the loop as 'stop-check-error' rather than launching passes
 * blind. The optional stopObserved seam is raced with each inter-tick sleep
 * so a stop seen while waiting wakes admission promptly — an in-flight pass
 * is never interrupted either way, and the stop seams hold at most one
 * pending observation per run.
 */
import { watch, type FSWatcher } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SELF_LOOP_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const SELF_LOOP_DEFAULT_INTERVAL_MS = 60_000;
export const SELF_LOOP_MIN_INTERVAL_MS = 1_000;

/** One pass's folded result: its exit code plus its parsed report (or null). */
export interface SelfLoopTickOutcome {
  exitCode: number;
  report: unknown;
}
/** The pass seam; each call is one full self-tick pass. */
export type SelfLoopTick = () => Promise<SelfLoopTickOutcome>;

/**
 * One completed pass as handed to the per-pass sink: its 1-based number,
 * its folded exit code, its report's top-level state string ('ran', 'busy',
 * …) when present, and its raw parsed report. Sanitizing and bounding the
 * payload for output is the sink's job; the loop retains nothing of it.
 */
export interface SelfLoopPassEvent {
  pass: number;
  exitCode: number;
  state: string | null;
  report: unknown;
  consecutiveFailures?: number;
  consecutiveBusy?: number;
  nextDelayMs?: number;
}
/**
 * Optional progress sink, awaited once per completed pass before any sleep.
 * A throwing sink is an explicit safe termination: the failing pass still
 * counts, no further pass is admitted, and the summary carries
 * observerError with termination 'observer-error'.
 */
export type SelfLoopPassObserver = (event: SelfLoopPassEvent) => void | Promise<void>;

/** The admission-stop verdict the injected stop seam returns per read. */
export type SelfLoopStopVerdict = 'continue' | 'stop';

export interface SelfLoopSummary {
  v: 1;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  durationMs: number;
  intervalMs: number;
  ticks: number;
  failures: number;
  busy: number;
  termination: 'duration' | 'max-ticks' | 'interrupted' | 'observer-error' | 'stop-file' | 'stop-check-error';
  /** The latest pass's parsed report (sanitized by the caller), or null. */
  lastReport: unknown;
  /**
   * Set only when the count bound caused exit: the max-ticks value supplied.
   */
  maxTicks?: number;
  /**
   * Set only when the per-pass sink threw: its message. Present solely on
   * that termination path, so non-streaming callers see no shape change.
   */
  observerError?: string;
}

export interface RunSelfLoopOptions {
  /** Finite positive pass budget; validated by the CLI wrapper. */
  durationMs: number;
  /** Optional count cap (1..1000), validated by the CLI wrapper. */
  maxTicks?: number;
  intervalMs: number;
  failureBackoffMaxMs?: number;
  /** Opt-in busy backoff cap, between the interval and SELF_LOOP_MAX_DURATION_MS (CLI-validated). */
  busyBackoffMaxMs?: number;
  tick: SelfLoopTick;
  now?: () => number;
  /** Sleep seam; must reject when the signal aborts so waiting stops at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Cancellation seam; the CLI aborts it from SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** Optional per-pass sink; awaited after each completed pass. See SelfLoopPassObserver. */
  onPass?: SelfLoopPassObserver;
  /** Optional async admission-stop seam, awaited before every pass: 'stop'
   *  ends admission with termination 'stop-file' and no further pass; a
   *  rejection ends the loop as 'stop-check-error' so errors never launch
   *  passes silently. */
  checkStop?: () => Promise<SelfLoopStopVerdict>;
  /** Optional factory raced with every inter-tick sleep so a stop observed
   *  while waiting wakes admission promptly; each call returns a fresh view
   *  settling at most once per observation so the loop can never spin. */
  stopObserved?: () => Promise<void>;
}

/** The default sleep: real time, interruptible by the abort signal. */
export function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error('aborted')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runSelfLoop(options: RunSelfLoopOptions): Promise<SelfLoopSummary> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepCancellable;
  const signal = options.signal ?? new AbortController().signal;
  const start = now();
  const deadline = start + options.durationMs;
  const maxTicks = options.maxTicks;
  let ticks = 0, failures = 0, busy = 0;
  let consecutiveFailures = 0, delayMs = options.intervalMs;
  let consecutiveBusy = 0, busyDelayMs = options.intervalMs;
  let lastReport: unknown = null;
  let observerError: string | undefined;
  let stopTermination: 'stop-file' | 'stop-check-error' | null = null;
  // A pre-aborted signal admits no pass at all: return immediately with
  // zero ticks, failures, and busy counters (the summary still reads
  // 'interrupted').  Otherwise the first pass is admitted; subsequent
  // passes only before the deadline and while no interruption is pending.
  // An in-flight pass always finishes.
  if (signal.aborted) {
    const end = now();
    return {
      v: 1,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      elapsedMs: end - start,
      durationMs: options.durationMs,
      intervalMs: options.intervalMs,
      ticks: 0,
      failures: 0,
      busy: 0,
      termination: 'interrupted',
      lastReport: null,
    };
  }
  while (!signal.aborted && now() < deadline
    && (maxTicks === undefined || ticks < maxTicks)) {
    if (options.checkStop !== undefined) {
      // The explicit stop order gates admission before every pass.
      let verdict: SelfLoopStopVerdict;
      try {
        verdict = await options.checkStop();
      } catch {
        stopTermination = 'stop-check-error';
        break;
      }
      if (verdict === 'stop') { stopTermination = 'stop-file'; break; }
    }
    let outcome: SelfLoopTickOutcome;
    try {
      outcome = await options.tick();
    } catch {
      outcome = { exitCode: 1, report: null };
    }
    ticks += 1;
    if (outcome.exitCode !== 0) failures += 1;
    const rawState = typeof outcome.report === 'object' && outcome.report !== null
      ? (outcome.report as Record<string, unknown>)['state'] : undefined;
    const state = typeof rawState === 'string' ? rawState : null;
    if (state === 'busy') busy += 1;
    if (options.failureBackoffMaxMs !== undefined) {
      if (state !== 'busy' && outcome.exitCode !== 0) {
        consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, consecutiveFailures + 1);
        delayMs = Math.min(options.failureBackoffMaxMs, delayMs * 2);
      } else {
        consecutiveFailures = 0;
        delayMs = options.intervalMs;
      }
    }
    if (options.busyBackoffMaxMs !== undefined) {
      if (state === 'busy') {
        consecutiveBusy = Math.min(Number.MAX_SAFE_INTEGER, consecutiveBusy + 1);
        busyDelayMs = Math.min(options.busyBackoffMaxMs, busyDelayMs * 2);
      } else {
        consecutiveBusy = 0;
        busyDelayMs = options.intervalMs;
      }
    }
    // The larger current delay; with one streak reset to the base interval
    // this is simply the active streak's delay.
    const scheduledMs = Math.max(delayMs, busyDelayMs);
    lastReport = outcome.report;
    if (options.onPass) {
      try {
        await options.onPass({
          pass: ticks, exitCode: outcome.exitCode, state, report: outcome.report,
          ...(options.failureBackoffMaxMs === undefined ? {} : { consecutiveFailures }),
          ...(options.busyBackoffMaxMs === undefined ? {} : { consecutiveBusy }),
          ...(options.failureBackoffMaxMs === undefined && options.busyBackoffMaxMs === undefined ? {} : {
            nextDelayMs: signal.aborted ? 0 : Math.max(0, Math.min(scheduledMs, deadline - now())),
          }),
        });
      } catch (error) {
        observerError = error instanceof Error ? error.message : String(error);
        break; // safe termination: the pass counts, admission stops here
      }
    }
    // Never sleep after the final allowed pass: break immediately when the
    // count cap has been reached, so no sleep runs after that final tick.
    if (maxTicks !== undefined && ticks >= maxTicks) break;
    const current = now();
    if (signal.aborted || current >= deadline) break;
    // Wait the interval, but never past the deadline: the remaining budget is
    // positive here, so the capped wait is too.
    try {
      const waitMs = Math.min(scheduledMs, deadline - current);
      const observed = options.stopObserved?.();
      if (observed === undefined) {
        await sleep(waitMs, signal);
      } else {
        // A stop observed mid-wait wins the race; the losing sleep is then
        // cancelled through its own controller (linked to the run signal) so
        // a real timer never keeps the process alive past the summary.
        const wake = new AbortController();
        const forward = () => wake.abort();
        signal.addEventListener('abort', forward, { once: true });
        try {
          await Promise.race([sleep(waitMs, wake.signal), observed]);
        } finally {
          signal.removeEventListener('abort', forward);
          wake.abort();
        }
      }
    } catch {
      // An interrupted sleep ends admission; the pass that ran is kept.
      break;
    }
  }
  const end = now();
  return {
    v: 1,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    elapsedMs: end - start,
    durationMs: options.durationMs,
    intervalMs: options.intervalMs,
    ticks,
    failures,
    busy,
    termination: stopTermination ?? (signal.aborted ? 'interrupted'
      : observerError === undefined
        ? (maxTicks !== undefined && ticks >= maxTicks ? 'max-ticks' : 'duration')
        : 'observer-error'),
    lastReport,
    ...(maxTicks !== undefined ? { maxTicks } : {}),
    ...(observerError === undefined ? {} : { observerError }),
  };
}

/** The wired admission-stop source for one explicit stop-file path. */
export interface SelfLoopStopAdmission {
  checkStop: () => Promise<SelfLoopStopVerdict>;
  stopObserved: () => Promise<void>;
  /** Releases the directory watch; idempotent. */
  close: () => void;
}

/**
 * Wire an explicit operator stop file (an absolute path a supervisor places
 * to stop admission) as the loop's stop seams. The path is only ever read,
 * never created or removed: while it is absent (ENOENT) checkStop says
 * 'continue'; once it exists, 'stop'; any other filesystem error rejects so
 * runSelfLoop ends as 'stop-check-error' instead of launching passes blind.
 * One event-driven watch on the parent directory (no polling) lets
 * stopObserved settle within the watch latency — well under a second — each
 * event confirmed by the same existence read; once fired, the observation is
 * delivered exactly once and never settles again, so the loop cannot spin. A
 * watch that cannot be established or dies mid-run degrades to the per-pass
 * read only; close() releases it and is safe to call repeatedly.
 */
export function watchSelfLoopStopFile(stopFile: string): SelfLoopStopAdmission {
  const checkStop = async (): Promise<SelfLoopStopVerdict> => {
    try {
      await lstat(stopFile);
      return 'stop';
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 'continue';
      throw cause;
    }
  };
  const never = new Promise<void>(() => {});
  let fired = false, delivered = false;
  let resolvePending!: () => void;
  const pending = new Promise<void>((resolve) => { resolvePending = resolve; });
  const confirm = () => void checkStop().then((verdict) => {
    if (verdict === 'stop' && !fired) { fired = true; resolvePending(); }
  }, () => undefined); // a failed confirm surfaces in the loop's own checkStop
  let watcher: FSWatcher | undefined;
  const unwatch = () => { try { watcher?.close(); } catch { /* already closed */ } watcher = undefined; };
  try {
    watcher = watch(dirname(stopFile), confirm);
    watcher.on('error', unwatch);
  } catch {
    watcher = undefined; // no watch: every pass boundary still re-reads the file
  }
  return {
    checkStop,
    stopObserved: () => {
      if (!fired) return pending;
      if (delivered) return never;
      delivered = true;
      return Promise.resolve();
    },
    close: unwatch,
  };
}
