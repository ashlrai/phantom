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
 * clock is still before the deadline and the abort signal is silent. A pass
 * already in flight when the deadline passes (or a signal arrives) finishes
 * normally — the loop never interrupts a tick. Sequencing is one awaited
 * tick, then one awaited sleep of the interval capped to the budget left
 * before the deadline: passes can therefore never overlap, and a window
 * shorter than the interval ends at its deadline, not one interval after it.
 * A nonzero or throwing tick ends that pass as a failure and the loop
 * continues; a tick reporting state 'busy' is counted and likewise
 * does not stop the loop.
 *
 * Memory is bounded by construction: the loop keeps integer counters and the
 * latest parsed report only — no history of ticks is retained. Progress is
 * reported through an optional per-pass sink (onPass) that the loop awaits
 * and then forgets; a throwing sink stops admission safely and is named in
 * the summary (termination 'observer-error') — it never crashes a tick.
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
  termination: 'duration' | 'interrupted' | 'observer-error';
  /** The latest pass's parsed report (sanitized by the caller), or null. */
  lastReport: unknown;
  /**
   * Set only when the per-pass sink threw: its message. Present solely on
   * that termination path, so non-streaming callers see no shape change.
   */
  observerError?: string;
}

export interface RunSelfLoopOptions {
  /** Finite positive pass budget; validated by the CLI wrapper. */
  durationMs: number;
  intervalMs: number;
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
  let ticks = 0, failures = 0, busy = 0;
  let lastReport: unknown = null;
  let observerError: string | undefined;
  // The first pass is always admitted; after that, only before the deadline
  // and while no interruption is pending. An in-flight pass always finishes.
  while (ticks === 0 || (!signal.aborted && now() < deadline)) {
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
    lastReport = outcome.report;
    if (options.onPass) {
      try {
        await options.onPass({ pass: ticks, exitCode: outcome.exitCode, state, report: outcome.report });
      } catch (error) {
        observerError = error instanceof Error ? error.message : String(error);
        break; // safe termination: the pass counts, admission stops here
      }
    }
    const current = now();
    if (signal.aborted || current >= deadline) break;
    // Wait the interval, but never past the deadline: the remaining budget is
    // positive here, so the capped wait is too.
    try {
      await sleep(Math.min(options.intervalMs, deadline - current), signal);
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
    termination: signal.aborted ? 'interrupted' : observerError === undefined ? 'duration' : 'observer-error',
    lastReport,
    ...(observerError === undefined ? {} : { observerError }),
  };
}
