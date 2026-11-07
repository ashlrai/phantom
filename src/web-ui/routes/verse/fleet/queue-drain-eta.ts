/**
 * routes/verse/fleet/queue-drain-eta.ts — estimate when a fleet lane's queue drains.
 *
 * Pure function — no DOM, no side channels, no randomness. Serves desktop views
 * that display "drains in ~10 min, 0 free slots at the next leader pass".
 *
 * Normalisation: non-finite or negative numbers clamp to 0; non-integers floor.
 * The function never throws.
 */

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                  */
/* ------------------------------------------------------------------ */

/** Clamp a normalised value (non-finite → 0, negative → 0, non-integer → floor). */
function clamp(n: number): number {
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Resolve an optional parameter: undefined → fallback, else clamp. */
function resolve(n: number | undefined, fallback: number): number {
  return n === undefined ? fallback : clamp(n);
}

/**
 * Compute free slots after `nextPassMinutes` elapse.
 *
 * 1. Some running jobs complete:  `floor(nextPassMinutes / avgJobMinutes)`
 *    completions, each freeing one slot (bounded by `min(running, target)`).
 * 2. Those freed slots are taken by queued jobs.
 * 3. Result is the remaining free slots, clamped to [0, target].
 *
 * When `avgJobMinutes` is 0 (normalised from a bad input) we assume no
 * completions, which is the safe fallback.
 */
function freeSlotsAtNextPass(
  freeSlots: number,
  running: number,
  target: number,
  queued: number,
  avgJobMinutes: number,
  nextPassMinutes: number,
): number {
  const completions =
    avgJobMinutes === 0
      ? 0
      : Math.floor(nextPassMinutes / avgJobMinutes) * Math.min(running, target);
  return Math.max(0, Math.min(target, freeSlots + completions) - queued);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export type QueueDrainInput = {
  running: number;
  target: number;
  queued: number;
  held: boolean;
  avgJobMinutes?: number;
  nextPassMinutes?: number;
};

export type QueueDrainResult = {
  freeSlots: number;
  drainMinutes: number | null;
  freeSlotsAtNextPass: number;
  state: 'held' | 'idle' | 'draining' | 'saturated';
};

/**
 * Estimate when a fleet lane's queue drains and predict free slots at the
 * next leader pass.
 *
 * - `freeSlots`        — currently unused slots (cap 0).
 * - `drainMinutes`     — estimated minutes until the queue empties (null when held).
 * - `freeSlotsAtNextPass` — expected free slots right after the next leader pass.
 * - `state`            — one of `held | idle | draining | saturated`.
 */
export function queueDrainEta(input: QueueDrainInput): QueueDrainResult {
  const running = clamp(input.running);
  const target  = clamp(input.target);
  const queued  = clamp(input.queued);
  const avgJobMinutes  = resolve(input.avgJobMinutes, 15);
  const nextPassMinutes = resolve(input.nextPassMinutes, 15);

  const freeSlots = Math.max(0, target - running);

  // ── held lane: nothing happens ──────────────────────────────────
  if (input.held) {
    return { freeSlots, drainMinutes: null, freeSlotsAtNextPass: 0, state: 'held' };
  }

  // ── empty queue ─────────────────────────────────────────────────
  if (queued === 0) {
    return {
      freeSlots,
      drainMinutes: 0,
      freeSlotsAtNextPass: freeSlotsAtNextPass(
        freeSlots, running, target, 0, avgJobMinutes, nextPassMinutes,
      ),
      state: freeSlots > 0 ? 'idle' : 'saturated',
    };
  }

  // ── queued > 0, compute drain ───────────────────────────────────
  let drainMinutes: number;

  if (running >= target) {
    // Every slot busy — queued jobs wait for a slot turnover.
    drainMinutes = Math.ceil(queued / Math.max(1, target)) * avgJobMinutes;
  } else if (queued <= freeSlots) {
    // Enough idle slots to absorb the queue immediately.
    drainMinutes = 0;
  } else {
    // Partial fill: only the overflow waits for a turnover.
    drainMinutes =
      Math.ceil((queued - freeSlots) / Math.max(1, target)) * avgJobMinutes;
  }

  const state: QueueDrainResult['state'] =
    freeSlots > 0 || drainMinutes <= nextPassMinutes
      ? 'draining'
      : 'saturated';

  return {
    freeSlots,
    drainMinutes,
    freeSlotsAtNextPass: freeSlotsAtNextPass(
      freeSlots, running, target, queued, avgJobMinutes, nextPassMinutes,
    ),
    state,
  };
}
