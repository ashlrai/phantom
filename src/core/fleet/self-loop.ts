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
 */
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
  termination: 'duration' | 'max-ticks' | 'interrupted' | 'observer-error';
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
      await sleep(Math.min(scheduledMs, deadline - current), signal);
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
    termination: signal.aborted ? 'interrupted'
      : observerError === undefined
        ? (maxTicks !== undefined && ticks >= maxTicks ? 'max-ticks' : 'duration')
        : 'observer-error',
    lastReport,
    ...(maxTicks !== undefined ? { maxTicks } : {}),
    ...(observerError === undefined ? {} : { observerError }),
  };
}
