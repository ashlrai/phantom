import { scoreOfflinePolicy, SOURCE_PROPENSITY_FLOOR } from './offline-policy-replay.js';

export interface ReplayComparisonResult {
  /** Both scores are returned, even if one is null */
  readonly incumbentScore: number | null;
  readonly candidateScore: number | null;
  readonly rowCount: number;
  readonly sufficientRows: boolean;
  /** null if either score is null, the difference between candidate and incumbent */
  readonly candidateMinusIncumbent: number | null;
  /** One of: insufficient-data, candidate-higher, incumbent-higher, or equal */
  readonly comparison: 'insufficient-data' | 'candidate-higher' | 'incumbent-higher' | 'equal';
}

/**
 * Compare two policies using the same test rows.
 * 
 * Calculates the same scores that would have been returned by promoteIfBetter
 * in the source PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886).
 * 
 * Returns detailed results without making any operational change.
 * 
 * @param rows Shared test rows to evaluate both policies on
 * @param incumbent The incumbent policy to evaluate  
 * @param candidate The candidate policy to evaluate
 * @param minRows Minimum number of rows required for a valid comparison (positive integer)
 * @param propensityFloor The propensity floor used in scoring (required and explicit)
 * @returns Comparison results showing both scores and relative performance
 */
export function compareOfflineReplay(
  rows: readonly unknown[],
  incumbent: {
    id: string;
    predictions: Record<string, Record<string, number>>;
  },
  candidate: {
    id: string;
    predictions: Record<string, Record<string, number>>;
  },
  minRows: number,
  propensityFloor: number
): ReplayComparisonResult {
  // Validate minRows
  if (!Number.isInteger(minRows) || minRows <= 0 || !Number.isFinite(minRows) || minRows > Number.MAX_SAFE_INTEGER) {
    throw new Error('minRows must be a positive finite integer');
  }
  
  // Validate propensityFloor 
  if (typeof propensityFloor !== 'number' || propensityFloor <= 0 || !Number.isFinite(propensityFloor)) {
    throw new Error('propensityFloor must be a finite positive number');
  }
  
  // Validate that rows array is not null/undefined
  if (!Array.isArray(rows)) {
    throw new Error('rows must be an array');
  }
  
  // Score both policies using the same input data and floor
  const incumbentInput = {
    rows,
    policy: incumbent,
    propensityFloor
  };
  
  const candidateInput = {
    rows,
    policy: candidate,
    propensityFloor
  };
  
  const incumbentScoreObj = scoreOfflinePolicy(incumbentInput);
  const candidateScoreObj = scoreOfflinePolicy(candidateInput);
  
  const incumbentScore = incumbentScoreObj.doublyRobust;
  const candidateScore = candidateScoreObj.doublyRobust;
  
  const rowCount = incumbentScoreObj.rowCount;
  const sufficientRows = rowCount >= minRows;
  
  // Calculate the difference (candidate - incumbent)
  let candidateMinusIncumbent: number | null = null;
  if (incumbentScore !== null && candidateScore !== null) {
    candidateMinusIncumbent = candidateScore - incumbentScore;
    
    // Reject non-finite results (shouldn't happen with valid inputs, but good to check)
    if (!Number.isFinite(candidateMinusIncumbent)) {
      throw new Error('Calculated difference is not finite');
    }
  }
  
  // Determine the comparison result
  let comparison: 'insufficient-data' | 'candidate-higher' | 'incumbent-higher' | 'equal' = 'insufficient-data';
  
  if (incumbentScore === null || candidateScore === null) {
    comparison = 'insufficient-data';
  } else if (candidateScore > incumbentScore) {
    comparison = 'candidate-higher';
  } else if (candidateScore < incumbentScore) {
    comparison = 'incumbent-higher';
  } else {
    comparison = 'equal';
  }
  
  return {
    incumbentScore,
    candidateScore,
    rowCount,
    sufficientRows,
    candidateMinusIncumbent,
    comparison
  };
}
