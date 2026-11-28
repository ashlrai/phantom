/**
 * Idle parking for the continuous resident loop.
 *
 * An idle continuous loop used to run a full tick every `idleBackoffMs`
 * (5 s): 720 ticks an hour of mirror prep, backlog refresh, self-heal and
 * capacity probes with nothing to dispatch. Each consecutive idle tick now
 * doubles the park up to `idleBackoffMaxMs`; any dispatch resets it.
 */
export const IDLE_BACKOFF_BASE_MS = 5_000;
export const IDLE_BACKOFF_MAX_MS = 60_000;
/** Lock-ownership re-read cadence; the KILL sentinel keeps its own 50 ms poll. */
export const OWNERSHIP_POLL_MS = 1_000;

/** Park before the next tick after `consecutiveIdle` idle ticks in a row (1 = first). */
export function idleParkMs(
  baseMs: number = IDLE_BACKOFF_BASE_MS,
  consecutiveIdle: number,
  maxMs: number = IDLE_BACKOFF_MAX_MS,
): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : IDLE_BACKOFF_BASE_MS;
  const cap = Math.max(base, Number.isFinite(maxMs) && maxMs > 0 ? maxMs : IDLE_BACKOFF_MAX_MS);
  const doublings = Math.min(30, Math.max(0, Math.floor(consecutiveIdle) - 1));
  return Math.min(cap, base * 2 ** doublings);
}

/** Ticks an idle loop runs in `windowMs`, given each tick's own duration. */
export function idleTicksInWindow(
  windowMs: number,
  park: (consecutiveIdle: number) => number,
  tickMs = 0,
): number {
  let elapsed = 0;
  let ticks = 0;
  while (elapsed < windowMs) {
    ticks++;
    elapsed += tickMs + park(ticks);
  }
  return ticks;
}
