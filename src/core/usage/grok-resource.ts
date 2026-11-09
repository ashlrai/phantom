/**
 * Grok as a world-model resource, not a coding dependency.
 *
 * Grok Ultra is a weekly allowance. When it is spent the lane sits at zero
 * capacity until the reset: other lanes keep running and nothing waits on
 * Grok. Policy (Eng Ops, 2026-11-09): never buy extra Grok credits.
 *
 * The seed below is the owner's manual reading. A newer reading in
 * usage-sensors.json supersedes it, and it stops applying once the window
 * resets. Times are written in UTC: America/New_York was on EST (UTC-5) on
 * both dates.
 */
import type { UsageSensorReading } from './sensor-reading.js';

/** Grok Ultra weekly limit, 2026-11-15 20:21 America/New_York. */
export const GROK_ULTRA_RESET_AT = '2026-11-16T01:21:00.000Z';

/** 51.4% used at 2026-11-09 02:12 America/New_York (21.1% at 12:47 the day before). */
export const GROK_ULTRA_MANUAL_READING = {
  observedAt: '2026-11-09T07:12:00.000Z',
  usedPercent: 51.4,
} as const;

/** The seed as a sensor reading, or nothing once its window has reset. */
export function grokManualSensorReadings(nowMs: number): UsageSensorReading[] {
  if (!Number.isFinite(nowMs) || nowMs >= Date.parse(GROK_ULTRA_RESET_AT)) return [];
  return [{
    lane: 'grok-ultra',
    observedAt: GROK_ULTRA_MANUAL_READING.observedAt,
    source: 'manual',
    staleAfter: new Date(Date.parse(GROK_ULTRA_MANUAL_READING.observedAt) + 15 * 60_000).toISOString(),
    used: GROK_ULTRA_MANUAL_READING.usedPercent,
    limit: 100,
    unit: 'percent',
    resetAt: GROK_ULTRA_RESET_AT,
  }];
}
