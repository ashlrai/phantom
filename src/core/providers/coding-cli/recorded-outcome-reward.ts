/**
 * Recorded outcome reward for one historical coding-CLI router outcome.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/learn.ts outcomeReward(outcome, config) -> calculateRecordedOutcomeReward()
 *   scheduler/types.ts RouterOutcome (merged, green, reverted, reviewRounds, wallMs)
 *                                      -> RecordedOutcomeRewardInput (only the fields read)
 *   scheduler/defaults.ts SchedulerConfig.latencyReferenceMs (field only, not its default)
 *                                      -> RecordedOutcomeRewardInput.latencyReferenceMs
 *
 * Formula (identical to the source expression order, so the floats match):
 *   success = merged && green && !reverted
 *   quality = success ? 1 / (1 + max(0, reviewRounds)) : 0
 *   latency = min(1, max(0, wallMs) / latencyReferenceMs)
 *   reward  = quality - 0.25 * latency
 *
 * Historical-offline scope: explains the reward behind a recorded row for audit. No
 * provider identity or defaults (source latencyReferenceMs = 600000 not recovered);
 * a live router, dispatch or eligibility decision is never derived from it.
 *
 * Pure and immutable: no clock, environment, I/O, telemetry or subscriptions. The
 * input object is never mutated.
 *
 * Divergences from the source `outcomeReward`:
 *   - Non-finite `reviewRounds`, `wallMs` or `latencyReferenceMs` throw a RangeError.
 *     The source let NaN or Infinity propagate into the reward.
 *   - Non-boolean `merged`, `green` or `reverted` throw a TypeError. The source
 *     coerced them by truthiness.
 *   - `latencyReferenceMs` must be finite and > 0. The source had no check here
 *     (the scheduler config validated the range separately).
 *   - Retained from the source: negative `wallMs` clamps to 0 and negative
 *     `reviewRounds` clamps to 0 (a recorded negative is treated as zero, not rejected).
 */

/** Weight of the latency penalty in the reward. */
export const RECORDED_LATENCY_WEIGHT = 0.25;

export interface RecordedOutcomeRewardInput {
  /** The change was merged. */
  merged: boolean;
  /** Checks were green. */
  green: boolean;
  /** The change was reverted after landing. */
  reverted: boolean;
  /** Review rounds before merge; a negative value is treated as 0. */
  reviewRounds: number;
  /** Wall-clock duration in milliseconds; a negative value is treated as 0. */
  wallMs: number;
  /** Latency at which the latency term saturates at 1. Must be > 0. */
  latencyReferenceMs: number;
}

export interface RecordedOutcomeRewardResult {
  /** quality - RECORDED_LATENCY_WEIGHT * latency. Can be negative. */
  reward: number;
  /** 1 / (1 + max(0, reviewRounds)) on success, otherwise 0. */
  quality: number;
  /** min(1, max(0, wallMs) / latencyReferenceMs), in [0, 1]. */
  latency: number;
  /** Always 'historical-offline': this value was derived from a recorded row. */
  provenance: 'historical-offline';
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
  return value;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

/**
 * Reward and its quality and latency components for one recorded outcome.
 * Validates every input before computing, so a bad field fails loudly instead of
 * producing NaN.
 */
export function calculateRecordedOutcomeReward(input: RecordedOutcomeRewardInput): RecordedOutcomeRewardResult {
  const merged = flag(input.merged, 'input.merged');
  const green = flag(input.green, 'input.green');
  const reverted = flag(input.reverted, 'input.reverted');
  const reviewRounds = finite(input.reviewRounds, 'input.reviewRounds');
  const wallMs = finite(input.wallMs, 'input.wallMs');
  const latencyReferenceMs = finite(input.latencyReferenceMs, 'input.latencyReferenceMs');
  if (latencyReferenceMs <= 0) throw new RangeError('input.latencyReferenceMs must be > 0');

  const success = merged && green && !reverted;
  const quality = success ? 1 / (1 + Math.max(0, reviewRounds)) : 0;
  const latency = Math.min(1, Math.max(0, wallMs) / latencyReferenceMs);
  return {
    reward: quality - RECORDED_LATENCY_WEIGHT * latency,
    quality,
    latency,
    provenance: 'historical-offline',
  };
}
