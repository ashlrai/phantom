/**
 * tick-phases.ts — RQ-DAEMONTICK-UNBLOCK: bounded tick phases.
 *
 * The resident daemon tick must always finish: `lastTickAt` froze for an
 * entire incident because ONE awaited stage (a hung subprocess await, a
 * never-settling probe, a `runGoal` that never returned) held the tick
 * open forever and `recordTick` — the only writer of `lastTickAt` — is
 * reached only after `tick()` returns.
 *
 * Every awaited stage of the tick now runs through `runTickPhase`, which
 * gives the stage:
 *   - an AbortSignal (aborted at the deadline or on daemon shutdown),
 *   - a bounded wait: after `deadlineMs` the phase is cancelled and given
 *     `graceMs` to wind down; if it still has not settled the tick stops
 *     waiting and the work continues DETACHED (its late rejection is
 *     swallowed, never an unhandled rejection),
 *   - a durable phase record `{name, status, durationMs, error}` appended
 *     to the open tick's ledger (persisted onto the DaemonTick record and
 *     `daemon.json` `lastTickPhases`),
 *   - a `noteTickPhase` heartbeat so `phm daemon status` can say WHERE the
 *     tick is, not just that it is running.
 *
 * Phase statuses: 'ok' | 'degraded' (threw) | 'timeout' (deadline exceeded)
 * | 'skipped' (intentionally not run, e.g. `skipTickPhase('no-frontier')`).
 * A 'running' entry appears only in in-progress snapshots.
 *
 * Tick outcomes (derived by `deriveTickOutcome`):
 *   ok       — every phase settled clean
 *   degraded — at least one phase threw
 *   timeout  — at least one phase exceeded its deadline (or the whole tick
 *              was abandoned at the runDaemon tick deadline)
 *   failed   — tick() threw before producing a record
 */
import type { DaemonTickOutcome, DaemonTickPhase, DaemonTickPhaseStatus } from '../types.js';
import { noteTickPhase, readTickProgress } from './tick-progress.js';

/** Default deadlines per phase class (operator-doc'd in docs/daemon-tick-phases.md). */
export const TICK_PHASE_MAINTENANCE_MS = 5 * 60_000;
export const TICK_PHASE_INVENT_MS = 3 * 60_000;
export const TICK_PHASE_REFLECTION_MS = 3 * 60_000;
export const TICK_PHASE_CAPACITY_MS = 30_000;
export const TICK_PHASE_DISPATCH_PLAN_MS = 60_000;
export const TICK_PHASE_BACKLOG_REFRESH_MS = 5 * 60_000;
/** How long a cancelled phase gets to settle before it is left detached. */
export const TICK_PHASE_GRACE_MS = 5_000;
/**
 * Bound on the frontier-client probe inside the invent phase. Absence must
 * skip the phase ('skipped: no-frontier'), never hold the tick open.
 */
export const TICK_PHASE_FRONTIER_PROBE_MS = 30_000;

/** Phase ledgers are metadata; cap them so state stays small. */
const MAX_TICK_PHASES = 40;
const MAX_PHASE_NAME_LEN = 120;
const MAX_PHASE_ERROR_LEN = 300;

// ---------------------------------------------------------------------------
// Open-tick phase ledger
// ---------------------------------------------------------------------------

let openPhases: DaemonTickPhase[] | null = null;
let inFlightPhase: { name: string; startedMs: number; nowMs: () => number } | null = null;

/** Open a fresh phase ledger. Called once at the top of tick(). */
export function beginTickPhases(): void {
  openPhases = [];
}

/**
 * Close the ledger and return the settled records. The next tick starts a
 * fresh ledger; a second `endTickPhases` without `beginTickPhases` returns
 * an empty list.
 */
export function endTickPhases(): DaemonTickPhase[] {
  const closed = openPhases ?? [];
  openPhases = null;
  inFlightPhase = null;
  return closed;
}

/**
 * Settled records plus — while a phase is in flight — a 'running' entry for
 * it. Snapshots never mutate the ledger; used by recordTick and by the
 * resident loop's post-tick persistence (which needs the ledger even when
 * the tick was abandoned at its deadline).
 */
export function tickPhasesSnapshot(nowMs: () => number = Date.now): DaemonTickPhase[] {
  const snapshot = openPhases ? [...openPhases] : [];
  if (inFlightPhase !== null) {
    snapshot.push({
      name: inFlightPhase.name,
      status: 'running',
      durationMs: Math.max(0, Math.round(nowMs() - inFlightPhase.startedMs)),
    });
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Phase-skip marker
// ---------------------------------------------------------------------------

/**
 * A phase returns `skipTickPhase(reason)` when it intentionally ran no work —
 * e.g. invent when no frontier client resolves. Distinct from 'ok' so
 * operators can see the tick did NOT do the stage; distinct from 'degraded'
 * because nothing failed.
 */
export interface TickPhaseSkipped {
  readonly skipped: true;
  readonly reason: string;
}

export function skipTickPhase(reason: string): TickPhaseSkipped {
  return { skipped: true, reason: boundedErrorText(reason) };
}

function isTickPhaseSkip(value: unknown): value is TickPhaseSkipped {
  return (
    typeof value === 'object' && value !== null &&
    (value as { skipped?: unknown }).skipped === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}

// ---------------------------------------------------------------------------
// Bounded phase runner
// ---------------------------------------------------------------------------

export interface TickPhaseRunOptions {
  /** Hard wait bound; the phase signal aborts here. */
  deadlineMs: number;
  /** Post-abort grace for the phase to settle before it is left detached. */
  graceMs?: number;
  /** Daemon shutdown / outer deadline — cascades into the phase signal. */
  parentSignal?: AbortSignal;
  /** One-line logger for non-ok outcomes (loop.ts's log). */
  log?: (line: string) => void;
  nowMs?: () => number;
}

export interface TickPhaseRun<T> {
  status: DaemonTickPhaseStatus;
  /** Present only for a settled 'ok' run. */
  value?: T;
  /** Short scrubbed reason for non-ok/skipped outcomes. */
  error?: string;
  durationMs: number;
  /** The record appended to the tick's phase ledger. */
  record: DaemonTickPhase;
}

function boundedErrorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_PHASE_ERROR_LEN);
}

function describeMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} s`;
  return `${Math.max(0, Math.round(ms))} ms`;
}

function errorText(err: unknown): string {
  return boundedErrorText(err instanceof Error ? err.message : String(err));
}

/**
 * Run `run(signal)` as a bounded tick phase. Never throws: a throw degrades
 * the phase; a deadline cancels the signal and — after grace — leaves the
 * work running detached with status 'timeout'. A `skipTickPhase` return
 * settles as 'skipped' with the reason in `error`.
 *
 * `run` is invoked synchronously; a synchronous throw is converted to a
 * degraded phase just like a rejection.
 */
export async function runTickPhase<T>(
  name: string,
  run: (signal: AbortSignal) => Promise<T | TickPhaseSkipped>,
  opts: TickPhaseRunOptions,
): Promise<TickPhaseRun<T>> {
  const now = opts.nowMs ?? Date.now;
  const phaseName = name.slice(0, MAX_PHASE_NAME_LEN);
  const deadlineMs = Math.max(1, opts.deadlineMs);
  const graceMs = Math.max(0, opts.graceMs ?? TICK_PHASE_GRACE_MS);
  // The ledger that was open WHEN this phase began. A phase detached past its
  // tick's ledger close (tick abandoned at the runDaemon deadline) writes to
  // its own closed list — never the next tick's fresh ledger.
  const ledger = openPhases;
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (opts.parentSignal?.aborted) controller.abort();
  else opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const started = now();
  // Pop-on-exit stage label: note the phase live so `phm daemon status` can
  // say where the tick is, then at settle restore the label that was current
  // at entry — but only when the phase's own name is still the last write.
  // This mirrors the maintenance pass's restore contract in loop.ts: a label
  // a stage set itself (or a newer tick's session) is never overwritten.
  const progressAtEntry = readTickProgress({ expectPid: process.pid });
  noteTickPhase(phaseName);
  const marker = { name: phaseName, startedMs: started, nowMs: now };
  inFlightPhase = marker;

  let status: DaemonTickPhaseStatus;
  let value: T | undefined;
  let error: string | undefined;
  const running = Promise.resolve().then(() => run(controller.signal));
  // Observed below in every branch; keeps a late rejection from surfacing as
  // an unhandled rejection once the tick has stopped waiting.
  running.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = <V>(ms: number, v: V): Promise<V> => new Promise<V>((resolveWait) => {
    timer = setTimeout(() => resolveWait(v), ms);
    timer.unref?.();
  });
  try {
    const first = await Promise.race([
      running.then((v) => ({ v }), (err) => ({ err })),
      wait(deadlineMs, 'deadline' as const),
    ]);
    if (first === 'deadline') {
      if (timer) clearTimeout(timer);
      controller.abort();
      const second = await Promise.race([
        running.then((v) => ({ v }), (err) => ({ err })),
        wait(graceMs, 'grace' as const),
      ]);
      status = 'timeout';
      const settled = second === 'grace' ? 'left running detached' : 'settled during abort grace';
      const detail = second !== 'grace' && 'err' in second ? `; settled rejected: ${errorText(second.err)}` : '';
      error = boundedErrorText(
        `phase exceeded its ${describeMs(deadlineMs)} deadline; cancelled and ${settled}${detail}`,
      );
      if (second !== 'grace' && !('err' in second) && !isTickPhaseSkip(second.v)) {
        value = second.v;
      }
    } else if ('err' in first) {
      status = 'degraded';
      error = errorText(first.err);
    } else if (isTickPhaseSkip(first.v)) {
      status = 'skipped';
      error = first.v.reason;
    } else {
      status = 'ok';
      value = first.v;
    }
  } finally {
    if (timer) clearTimeout(timer);
    opts.parentSignal?.removeEventListener('abort', onParentAbort);
    if (inFlightPhase === marker) inFlightPhase = null;
    const progressNow = readTickProgress({ expectPid: process.pid });
    if (
      progressAtEntry && progressNow &&
      progressNow.progress.tickStartedAt === progressAtEntry.progress.tickStartedAt &&
      progressNow.progress.phase === phaseName
    ) {
      noteTickPhase(progressAtEntry.progress.phase, progressAtEntry.progress.detail);
    }
  }

  const durationMs = Math.max(0, Math.round(now() - started));
  const record: DaemonTickPhase = {
    name: phaseName,
    status,
    durationMs,
    ...(error !== undefined ? { error } : {}),
  };
  if (ledger !== null && ledger.length < MAX_TICK_PHASES) ledger.push(record);
  if (status === 'degraded' || status === 'timeout') {
    try {
      opts.log?.(`[tick] phase ${phaseName} ${status}: ${error ?? 'no detail'}`);
    } catch { /* logging must not break the phase contract */ }
  }
  return { status, value, error, durationMs, record };
}

// ---------------------------------------------------------------------------
// Outcome derivation
// ---------------------------------------------------------------------------

/**
 * Fold the settled phase ledger (plus whole-tick failure signals from the
 * resident loop) into one `lastTickOutcome`. Precedence:
 * failed > timeout > degraded > ok.
 */
export function deriveTickOutcome(input: {
  phases: readonly DaemonTickPhase[];
  tickFailed?: boolean;
  tickTimedOut?: boolean;
}): DaemonTickOutcome {
  if (input.tickFailed === true) return 'failed';
  if (input.tickTimedOut === true) return 'timeout';
  if (input.phases.some((phase) => phase.status === 'timeout')) return 'timeout';
  if (input.phases.some((phase) => phase.status === 'degraded')) return 'degraded';
  return 'ok';
}

/** Test-only: drop the open ledger and in-flight marker. */
export function resetTickPhasesForTests(): void {
  openPhases = null;
  inFlightPhase = null;
}
