/**
 * Backward-compatible re-export from the refactored pacing module.
 * The original pacing logic was moved to src/core/resources/pacing/ as part of
 * the receding-horizon solver refactor (#1253). This file redirects imports so
 * existing callers and tests continue to work without changes.
 *
 * @module resources/pacing
 */
export type {
  HorizonKnobs, PacePoint, PoolPaceSeries, ReadingStamp, PacePlan, HorizonPlan,
} from './pacing/index.js';
export {
  safetyBuffer, paceWindow, planHorizon, stubSeries, seriesFromManual,
} from './pacing/index.js';
export type { PaceSolver, PaceSolverOutcome } from './pacing/index.js';

/** Cumulative fraction available under the pace line and optional lead. */
export function paceCeilingAt(input: { nowMs: number; resetAtMs: number; windowStartMs: number; leadFraction?: number }): number {
  const { nowMs, resetAtMs, windowStartMs } = input;
  const lead = input.leadFraction ?? 0;
  if (![nowMs, resetAtMs, windowStartMs, lead].every(Number.isFinite)
      || windowStartMs >= resetAtMs || lead < 0 || lead > 1
      || nowMs <= windowStartMs || nowMs >= resetAtMs) return 0;
  return Math.min(1, Math.max(0, (nowMs - windowStartMs) / (resetAtMs - windowStartMs) + lead));
}
