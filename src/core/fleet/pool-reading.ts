/**
 * What a pool's usage reading means right now. Pure: no clock, no I/O.
 *
 * A reading taken before the pool's reset time describes the old window. Once
 * the reset has passed, that pool is refilled (0% used) until a sensor reports
 * the new window. Software already has this answer, so nobody is asked for it.
 */

/** One usage reading: a ledger lane's current reading or a stored sensor sample. */
export interface PoolReading {
  used_pct: number | null;
  /** When the percentage was captured. */
  observed_at: string | null;
  /** When the window this reading belongs to resets. */
  reset_at: string | null;
}
/** A sensor reading from any source (header probe, usage history, dispatcher). */
export type PoolSensor = Pick<PoolReading, 'used_pct' | 'observed_at'>;

/** `measured`: a real reading stands. `refilled`: reset passed, no new reading yet or the new one. `unknown`: no usable reading. */
export type PoolReadingState = 'measured' | 'refilled' | 'unknown';
export interface EffectivePoolReading {
  used_pct: number | null;
  /** When `used_pct` was observed; null when it is the assumed 0% of a refill. */
  observed_at: string | null;
  state: PoolReadingState;
  /** Why the number is what it is, in plain words; null when the reading is measured as given. */
  basis: string | null;
}

const ms = (iso: string | null): number => (iso === null ? NaN : Date.parse(iso));

/** Newest sensor with a valid capture time in (afterMs, nowMs]. */
function newest(sensors: readonly PoolSensor[], afterMs: number, nowMs: number): PoolSensor | null {
  let best: PoolSensor | null = null;
  let bestMs = -Infinity;
  for (const sensor of sensors) {
    const at = ms(sensor.observed_at);
    if (sensor.used_pct === null || !Number.isFinite(sensor.used_pct) || !Number.isFinite(at)) continue;
    if (at > afterMs && at <= nowMs && at > bestMs) { best = sensor; bestMs = at; }
  }
  return best;
}

export function effectivePoolReading(reading: PoolReading, sensors: readonly PoolSensor[], now: number): EffectivePoolReading {
  const observedMs = ms(reading.observed_at);
  const resetMs = ms(reading.reset_at);
  const known = reading.used_pct !== null && Number.isFinite(reading.used_pct);
  // Refilled only when the reading provably predates the reset; a reading with no capture time proves nothing.
  if (known && Number.isFinite(resetMs) && now >= resetMs && Number.isFinite(observedMs) && observedMs < resetMs) {
    // Only readings from the new window count; the old window's numbers say nothing about it.
    const fresh = newest(sensors, resetMs - 1, now);
    if (fresh) return { used_pct: fresh.used_pct, observed_at: fresh.observed_at, state: 'measured', basis: null };
    return { used_pct: 0, observed_at: null, state: 'refilled', basis: `reset passed at ${reading.reset_at}` };
  }
  if (!known) {
    const later = newest(sensors, Number.isFinite(observedMs) ? observedMs : -Infinity, now);
    return later ? { used_pct: later.used_pct, observed_at: later.observed_at, state: 'measured', basis: null }
      : { used_pct: null, observed_at: reading.observed_at, state: 'unknown', basis: null };
  }
  const later = newest(sensors, observedMs, now);
  if (later) return { used_pct: later.used_pct, observed_at: later.observed_at, state: 'measured', basis: null };
  return { used_pct: reading.used_pct, observed_at: reading.observed_at, state: 'measured', basis: null };
}
