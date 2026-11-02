/**
 * Backward-compatible re-export from the refactored pacing module.
 * The original pacing logic was moved to src/core/resources/pacing/ as part of
 * the receding-horizon solver refactor (#1253). This file redirects imports so
 * existing callers and tests continue to work without changes.
 *
 * @module resources/pacing
 */
export {
  HorizonKnobs, PacePoint, PoolPaceSeries, ReadingStamp, PacePlan, HorizonPlan,
  safetyBuffer, paceWindow, planHorizon, stubSeries, seriesFromManual,
} from './pacing/index.js';
export type { PaceSolver, PaceSolverOutcome } from './pacing/index.js';
