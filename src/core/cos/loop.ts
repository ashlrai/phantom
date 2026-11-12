/**
 * loop.ts — the bounded repeating driver for the chief-of-staff worker.
 *
 * runCosWorkOnce (worker.ts) answers AT MOST ONE queued cos-* intake job per
 * call; Mason's Nov 1 order — input from desktop, Telegram and email gets
 * real replies, fully autonomously — needs something to call it again while
 * a backlog or a later arrival is still waiting. runCosLoop is that
 * repetition, and only that repetition: every pass is the injected work seam
 * (the real default is runCosWorkOnce, so the PAUSE switch, the claim race
 * and the approval-bound draft all stay inside the existing pass; this
 * module implements no second policy). Deliberately NOT wired into
 * fleet self-tick, whose Tier-1 import closure makes any change there an
 * owner-reviewed act: a host timer or an agent starts this loop instead.
 *
 * Admission is decided by the clock, never by the pass counter: the first
 * pass starts immediately, and a further pass is admitted only while the
 * clock is still before the deadline and the abort signal is silent. If the
 * signal is already set when runCosLoop is called, no pass is admitted at
 * all. A pass already in flight when the deadline passes (or a signal
 * arrives) finishes normally — the loop never interrupts the worker.
 * Sequencing is one awaited pass, then one awaited sleep, so passes can
 * never overlap.
 *
 * The wait after a pass depends on its outcome. 'drafted' means a job was
 * claimed and answered — the queue may hold more, so the next pass is
 * admitted with no wait at all (the backlog drains at worker speed).
 * 'idle', 'paused' and 'blocked' wait one interval, capped to the budget
 * left before the deadline. A pass that throws counts as an error and the
 * loop continues after an interval; errors carry no reason and are never
 * part of the blocked streak.
 *
 * Five consecutive 'blocked' passes with the SAME reason end the loop with
 * termination 'blocked-streak': that signature is a dead runner slate (no
 * usable login), where polling again only burns the claim path. A blocked
 * pass with a different reason, or any other outcome, resets the streak.
 * The last blocked reason is kept in the summary — it is one of worker.ts's
 * short fixed strings, never model output.
 *
 * Memory is bounded by construction: integer counters and the last blocked
 * reason only. Progress is reported through the optional onPass sink, which
 * the loop awaits once per completed pass and then forgets. No model output
 * ever enters an event or the summary.
 */
import { sleepCancellable } from '../fleet/self-loop.js';
import { runCosWorkOnce, type CosWorkOptions, type CosWorkResult } from './worker.js';

export const COS_LOOP_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const COS_LOOP_DEFAULT_INTERVAL_MS = 30_000;
export const COS_LOOP_MIN_INTERVAL_MS = 5_000;
export const COS_LOOP_MAX_PASSES = 1_000;
export const COS_LOOP_BLOCKED_STREAK_LIMIT = 5;
export const COS_LOOP_DEFAULT_PASS_TIMEOUT_MS = 10 * 60 * 1000;

/** The pass seam; each call is one bounded cos-work pass. */
export type CosLoopWork = (options: CosWorkOptions) => Promise<CosWorkResult>;

/** One completed pass as handed to the per-pass sink: its 1-based number, its
 * folded outcome ('error' covers a throwing pass) and the job id when the
 * pass named one. Sanitizing for output is the sink's job. */
export interface CosLoopPassEvent {
  pass: number;
  outcome: CosWorkResult['outcome'] | 'error';
  id?: string;
}

export type CosLoopObserver = (event: CosLoopPassEvent) => void | Promise<void>;

export interface CosLoopSummary {
  v: 1;
  passes: number;
  drafted: number;
  idle: number;
  paused: number;
  blocked: number;
  errors: number;
  termination: 'deadline' | 'max-passes' | 'signal' | 'blocked-streak';
  /** The most recent blocked reason — a short fixed worker string, never output. */
  lastBlockedReason?: string;
}

export interface RunCosLoopOptions {
  /** Positive pass budget, at most 24 h; validated by the CLI wrapper. */
  durationMs: number;
  /** Wait after a non-drafted pass (default 30 s, min 5 s). */
  intervalMs?: number;
  /** Optional count cap (1..1000); whichever bound occurs first stops admission. */
  maxPasses?: number;
  /** Runs root forwarded to every pass; defaults inside runCosWorkOnce. */
  runsDir?: string;
  /** Per-pass runner kill deadline forwarded to runCosWorkOnce (default 10 min). */
  timeoutMs?: number;
  /** Pass seam; defaults to runCosWorkOnce. */
  work?: CosLoopWork;
  /** Sleep seam; must reject when the signal aborts so waiting stops at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Cancellation seam; the CLI aborts it from SIGINT/SIGTERM. */
  signal?: AbortSignal;
  /** Optional per-pass sink; awaited after each completed pass before any sleep. */
  onPass?: CosLoopObserver;
}

export async function runCosLoop(options: RunCosLoopOptions): Promise<CosLoopSummary> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepCancellable;
  const signal = options.signal ?? new AbortController().signal;
  const work = options.work ?? runCosWorkOnce;
  const intervalMs = options.intervalMs ?? COS_LOOP_DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? COS_LOOP_DEFAULT_PASS_TIMEOUT_MS;
  const deadline = now() + options.durationMs;
  const maxPasses = options.maxPasses;

  let passes = 0, drafted = 0, idle = 0, paused = 0, blocked = 0, errors = 0;
  let lastBlockedReason: string | undefined;
  let blockedStreak = 0, streakReason: string | undefined;
  let stopped = false;

  // A pre-aborted signal admits no pass at all — the summary still reads
  // 'signal'. Otherwise the first pass is admitted; subsequent passes only
  // before the deadline and while no interruption is pending. An in-flight
  // pass always finishes.
  while (!signal.aborted && now() < deadline
    && (maxPasses === undefined || passes < maxPasses)) {
    let outcome: CosLoopPassEvent['outcome'];
    let id: string | undefined;
    try {
      const result = await work({
        ...(options.runsDir === undefined ? {} : { runsDir: options.runsDir }),
        timeoutMs,
        now,
      });
      outcome = result.outcome;
      if (result.outcome === 'drafted' || result.outcome === 'blocked') {
        id = result.id;
        if (result.outcome === 'blocked') lastBlockedReason = result.reason;
      }
    } catch {
      outcome = 'error';
    }
    passes += 1;
    if (outcome === 'drafted') drafted += 1;
    else if (outcome === 'idle') idle += 1;
    else if (outcome === 'paused') paused += 1;
    else if (outcome === 'blocked') {
      blocked += 1;
      // Same-reason streak: a new reason restarts the count at one.
      if (lastBlockedReason === streakReason) blockedStreak += 1;
      else { streakReason = lastBlockedReason; blockedStreak = 1; }
    } else errors += 1;
    if (outcome !== 'blocked') { blockedStreak = 0; streakReason = undefined; }
    if (options.onPass) {
      await options.onPass({ pass: passes, outcome, ...(id === undefined ? {} : { id }) });
    }
    // A dead runner slate stops the loop before any further sleep or pass.
    if (blockedStreak >= COS_LOOP_BLOCKED_STREAK_LIMIT) { stopped = true; break; }
    // Never sleep after the final allowed pass.
    if (maxPasses !== undefined && passes >= maxPasses) break;
    const current = now();
    if (signal.aborted || current >= deadline) break;
    // 'drafted' means the claim won a job and more may be READY: admit the
    // next pass immediately (the while-guard still applies the deadline,
    // the signal and the count cap). Every other outcome waits one interval,
    // capped so a window shorter than the interval ends at its deadline.
    if (outcome !== 'drafted') {
      try {
        await sleep(Math.min(intervalMs, deadline - current), signal);
      } catch {
        // An interrupted sleep ends admission; the pass that ran is kept.
        break;
      }
    }
  }

  return {
    v: 1,
    passes,
    drafted,
    idle,
    paused,
    blocked,
    errors,
    termination: stopped ? 'blocked-streak'
      : signal.aborted ? 'signal'
        : (maxPasses !== undefined && passes >= maxPasses ? 'max-passes' : 'deadline'),
    ...(lastBlockedReason === undefined ? {} : { lastBlockedReason }),
  };
}
