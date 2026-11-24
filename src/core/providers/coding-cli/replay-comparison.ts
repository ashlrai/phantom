/**
 * Offline incumbent-versus-candidate replay comparison over shared rows.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/learn.ts  promoteIfBetter()  -> compareOfflineReplay()
 *
 * Recut of PR #7391 (RQ-PHX-REPLAYCOMPARE654S), whose bridge never compiled
 * against the real scorer contract. Pure: no I/O, clock, randomness, routing,
 * provider defaults or promotion. Both policies are scored by
 * scoreOfflinePolicy() on the same rows and the same propensity floor, and
 * every calculated value is returned — the caller decides what it means. The
 * comparison is strict: no epsilon or tolerance, exact number comparisons
 * only. It is not evidence of superiority, deployment safety or live behavior
 * (the score's `claims` stay false; see offline-policy-replay.ts).
 *
 * Deliberate divergences from the source:
 *   - Nothing is ever promoted: the source's activation and operational
 *     promotion, fallback and default-policy handling are not recovered.
 *   - `minRows` gates only the `comparison` verdict. A row count below
 *     `minRows` is missing evidence for a decision, so the verdict is
 *     'insufficient-data' even though both scores (and their raw difference)
 *     are still reported, exactly as the source refused to compare on thin
 *     evidence.
 *   - Validation happens here for the comparison's own contract (`minRows`,
 *     `propensityFloor`, `rows`); row, policy and prediction validation is
 *     the scorer's, and its errors propagate unchanged.
 */

import {
  type OfflineReplayPolicy,
  type OfflineReplayRow,
  scoreOfflinePolicy,
} from './offline-policy-replay.js';

export interface ReplayComparisonResult {
  /** Both scores are returned, even if one is null. */
  readonly incumbentScore: number | null;
  readonly candidateScore: number | null;
  /** Number of shared rows both policies were scored on. */
  readonly rowCount: number;
  /** Whether rowCount met the caller's minRows. Gates `comparison`. */
  readonly sufficientRows: boolean;
  /** null if either score is null; otherwise candidate − incumbent. */
  readonly candidateMinusIncumbent: number | null;
  /** One of: insufficient-data, candidate-higher, incumbent-higher, equal. */
  readonly comparison: 'insufficient-data' | 'candidate-higher' | 'incumbent-higher' | 'equal';
}

/**
 * Compare two policies using the same rows and propensity floor.
 *
 * Calculates the same scores the source PR's promoteIfBetter would have
 * compared, without making any operational change.
 *
 * @param rows Shared rows to evaluate both policies on. Validated by the
 *   scorer; its TypeError/RangeError propagate.
 * @param incumbent The incumbent policy to evaluate.
 * @param candidate The candidate policy to evaluate.
 * @param minRows Minimum number of rows required for a valid comparison.
 *   Must be a positive finite integer.
 * @param propensityFloor The propensity floor used in scoring. Required and
 *   explicit (the source hard-coded SOURCE_PROPENSITY_FLOOR = 1e-3); must be
 *   a finite positive number, and the scorer additionally requires (0, 1].
 * @returns Comparison results showing both scores and relative performance.
 */
export function compareOfflineReplay(
  rows: readonly OfflineReplayRow[],
  incumbent: OfflineReplayPolicy,
  candidate: OfflineReplayPolicy,
  minRows: number,
  propensityFloor: number,
): ReplayComparisonResult {
  if (!Number.isInteger(minRows) || !Number.isFinite(minRows) || minRows <= 0 || minRows > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('minRows must be a positive finite integer');
  }

  if (typeof propensityFloor !== 'number' || !Number.isFinite(propensityFloor) || propensityFloor <= 0) {
    throw new RangeError('propensityFloor must be a finite positive number');
  }

  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  // Score both policies on the same rows and the same floor.
  const incumbentScoreObj = scoreOfflinePolicy({ rows, policy: incumbent, propensityFloor });
  const candidateScoreObj = scoreOfflinePolicy({ rows, policy: candidate, propensityFloor });

  const incumbentScore = incumbentScoreObj.doublyRobust;
  const candidateScore = candidateScoreObj.doublyRobust;

  const rowCount = incumbentScoreObj.rowCount;
  const sufficientRows = rowCount >= minRows;

  // Raw difference whenever both scores exist. Reported even when the row
  // count is insufficient: it is arithmetic, not a verdict.
  let candidateMinusIncumbent: number | null = null;
  if (incumbentScore !== null && candidateScore !== null) {
    candidateMinusIncumbent = candidateScore - incumbentScore;
    if (!Number.isFinite(candidateMinusIncumbent)) {
      throw new RangeError('Calculated difference is not finite');
    }
  }

  // Strict comparison. Thin evidence is not a verdict: below minRows, or with
  // either score null, the only honest answer is insufficient-data.
  let comparison: ReplayComparisonResult['comparison'] = 'insufficient-data';
  if (sufficientRows && incumbentScore !== null && candidateScore !== null) {
    if (candidateScore > incumbentScore) comparison = 'candidate-higher';
    else if (candidateScore < incumbentScore) comparison = 'incumbent-higher';
    else comparison = 'equal';
  }

  return {
    incumbentScore,
    candidateScore,
    rowCount,
    sufficientRows,
    candidateMinusIncumbent,
    comparison,
  };
}
