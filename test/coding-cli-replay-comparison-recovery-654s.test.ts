import { describe, expect, it } from 'vitest';

import {
  offlineCandidateKey,
  type OfflineReplayCandidate,
  type OfflineReplayPolicy,
  type OfflineReplayRow,
} from '../src/core/providers/coding-cli/offline-policy-replay.js';
import { compareOfflineReplay } from '../src/core/providers/coding-cli/replay-comparison.js';

// Recovered from PR #5952 promoteIfBetter(), recut from #7391 (RQ-PHX-REPLAYCOMPARE654S).
// Every identifier and number here is synthetic.

const A: OfflineReplayCandidate = { poolId: 'synthetic-a', consumer: 'consumer-a' };
const B: OfflineReplayCandidate = { poolId: 'synthetic-b', consumer: null };

function row(
  rowId: string,
  logged: OfflineReplayCandidate,
  propensity: number,
  reward: number,
  eligible: readonly OfflineReplayCandidate[] = [A, B],
): OfflineReplayRow {
  return { rowId, loggedPoolId: logged.poolId, loggedConsumer: logged.consumer, propensity, reward, eligible };
}

/** Predictions for one row, keyed by candidate identity. */
function preds(pairs: Array<[OfflineReplayCandidate, number]>): Record<string, number> {
  return Object.fromEntries(pairs.map(([c, v]) => [offlineCandidateKey(c.poolId, c.consumer), v]));
}

const sampleRows: readonly OfflineReplayRow[] = [
  // Logged A at propensity 1.0, reward 0.9.
  row('row1', A, 1.0, 0.9),
  // Logged B at propensity 0.5, reward 0.6.
  row('row2', B, 0.5, 0.6),
];

/** Chases B on both rows: unmatched on row1 (DR 0.2), matched on row2 (DR 1.0). Mean 0.6. */
const incumbentPolicy: OfflineReplayPolicy = {
  id: 'incumbent',
  predictions: {
    row1: preds([
      [A, 0.1],
      [B, 0.2],
    ]),
    row2: preds([
      [A, 0.1],
      [B, 0.2],
    ]),
  },
};

/** Chases A on both rows: matched on row1 (DR 0.9), unmatched on row2 (DR 0.8). Mean 0.85. */
const candidatePolicy: OfflineReplayPolicy = {
  id: 'candidate',
  predictions: {
    row1: preds([
      [A, 0.8],
      [B, 0.1],
    ]),
    row2: preds([
      [A, 0.8],
      [B, 0.1],
    ]),
  },
};

describe('compareOfflineReplay', () => {
  it('should return equal comparison when scores are equal', () => {
    const result = compareOfflineReplay(sampleRows, incumbentPolicy, incumbentPolicy, 1, 1e-3);

    expect(result.incumbentScore).toBeGreaterThan(0);
    expect(result.candidateScore).toBeGreaterThan(0);
    expect(result.comparison).toBe('equal');
    expect(result.sufficientRows).toBe(true);
    expect(result.candidateMinusIncumbent).toBe(0);
  });

  it('should return candidate-higher when candidate score is better', () => {
    const result = compareOfflineReplay(sampleRows, incumbentPolicy, candidatePolicy, 1, 1e-3);

    expect(result.candidateScore).toBeGreaterThan(result.incumbentScore);
    expect(result.comparison).toBe('candidate-higher');
    expect(result.sufficientRows).toBe(true);
    expect(result.candidateMinusIncumbent).toBeGreaterThan(0);
  });

  it('should return incumbent-higher when incumbent score is better', () => {
    const result = compareOfflineReplay(sampleRows, candidatePolicy, incumbentPolicy, 1, 1e-3);

    expect(result.incumbentScore).toBeGreaterThan(result.candidateScore);
    expect(result.comparison).toBe('incumbent-higher');
    expect(result.sufficientRows).toBe(true);
    expect(result.candidateMinusIncumbent).toBeLessThan(0);
  });

  it('should return insufficient-data when rows is empty', () => {
    const emptyPolicy: OfflineReplayPolicy = { id: 'empty', predictions: {} };

    const result = compareOfflineReplay([], emptyPolicy, emptyPolicy, 1, 1e-3);

    expect(result.incumbentScore).toBeNull();
    expect(result.candidateScore).toBeNull();
    expect(result.rowCount).toBe(0);
    expect(result.comparison).toBe('insufficient-data');
    expect(result.sufficientRows).toBe(false);
    expect(result.candidateMinusIncumbent).toBeNull();
  });

  it('should handle insufficient rows correctly', () => {
    // One scored row below minRows 2: scores exist, but the verdict must not.
    const oneRow: readonly OfflineReplayRow[] = [sampleRows[0]!];
    const incumbentOne: OfflineReplayPolicy = { id: 'incumbent', predictions: { row1: incumbentPolicy.predictions.row1! } };
    const candidateOne: OfflineReplayPolicy = { id: 'candidate', predictions: { row1: candidatePolicy.predictions.row1! } };

    const result = compareOfflineReplay(oneRow, incumbentOne, candidateOne, 2, 1e-3);

    expect(result.rowCount).toBe(1);
    expect(result.sufficientRows).toBe(false);
    expect(result.comparison).toBe('insufficient-data');
    // The raw difference is still reported; it is arithmetic, not a verdict.
    expect(result.candidateMinusIncumbent).not.toBeNull();
  });

  it('should handle the boundary case with exactly minRows', () => {
    const result = compareOfflineReplay(sampleRows, incumbentPolicy, candidatePolicy, 2, 1e-3);

    expect(result.sufficientRows).toBe(true);
    expect(result.comparison).toBe('candidate-higher');
  });

  it('should throw on invalid minRows', () => {
    const emptyPolicy: OfflineReplayPolicy = { id: 'empty', predictions: {} };

    expect(() => compareOfflineReplay(sampleRows, emptyPolicy, emptyPolicy, -1, 1e-3)).toThrow(
      'minRows must be a positive finite integer',
    );
    expect(() => compareOfflineReplay(sampleRows, emptyPolicy, emptyPolicy, 0, 1e-3)).toThrow(
      'minRows must be a positive finite integer',
    );
    expect(() => compareOfflineReplay(sampleRows, emptyPolicy, emptyPolicy, 1.5, 1e-3)).toThrow(
      'minRows must be a positive finite integer',
    );
  });

  it('should throw on invalid propensityFloor', () => {
    const emptyPolicy: OfflineReplayPolicy = { id: 'empty', predictions: {} };

    expect(() => compareOfflineReplay(sampleRows, emptyPolicy, emptyPolicy, 1, -1e-3)).toThrow(
      'propensityFloor must be a finite positive number',
    );
    expect(() => compareOfflineReplay(sampleRows, emptyPolicy, emptyPolicy, 1, 0)).toThrow(
      'propensityFloor must be a finite positive number',
    );
    expect(() => compareOfflineReplay(sampleRows, emptyPolicy, emptyPolicy, 1, Infinity)).toThrow(
      'propensityFloor must be a finite positive number',
    );
  });

  it('should validate that rows is an array', () => {
    const emptyPolicy: OfflineReplayPolicy = { id: 'empty', predictions: {} };

    expect(() =>
      compareOfflineReplay(null as unknown as readonly OfflineReplayRow[], emptyPolicy, emptyPolicy, 1, 1e-3),
    ).toThrow('rows must be an array');
  });
});
