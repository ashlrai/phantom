import { describe, expect, it } from 'vitest';

import {
  offlineCandidateKey,
  scoreOfflinePolicy,
  type OfflineReplayCandidate,
  type OfflineReplayPolicy,
  type OfflineReplayRow,
} from '../src/core/providers/coding-cli/offline-policy-replay.js';
import { compareOfflineReplay } from '../src/core/providers/coding-cli/replay-comparison.js';

// RQ-PHX-REDTESTFIXC685 recut of #7391 (RQ-PHX-REPLAYCOMPARE654S). These cases
// exercise the recut behavior of compareOfflineReplay through its real entry
// point and the real scorer underneath it. All values are synthetic.

const A: OfflineReplayCandidate = { poolId: 'recut-a', consumer: 'recut-consumer' };
const B: OfflineReplayCandidate = { poolId: 'recut-b', consumer: null };

const rows: readonly OfflineReplayRow[] = [
  { rowId: 'r1', loggedPoolId: A.poolId, loggedConsumer: A.consumer, propensity: 0.8, reward: 0.7, eligible: [A, B] },
  { rowId: 'r2', loggedPoolId: B.poolId, loggedConsumer: B.consumer, propensity: 0.4, reward: 0.5, eligible: [A, B] },
];

function table(a: number, b: number): Record<string, number> {
  return { [offlineCandidateKey(A.poolId, A.consumer)]: a, [offlineCandidateKey(B.poolId, B.consumer)]: b };
}

const incumbent: OfflineReplayPolicy = { id: 'recut-incumbent', predictions: { r1: table(0.9, 0.1), r2: table(0.9, 0.1) } };
const candidate: OfflineReplayPolicy = { id: 'recut-candidate', predictions: { r1: table(0.2, 0.8), r2: table(0.2, 0.8) } };

describe('recut-redtestfix-c685: compareOfflineReplay via the real scorer', () => {
  it('reports exactly the scores scoreOfflinePolicy computes for the same rows and floor', () => {
    const floor = 1e-3;
    const result = compareOfflineReplay(rows, incumbent, candidate, 1, floor);

    expect(result.incumbentScore).toBe(scoreOfflinePolicy({ rows, policy: incumbent, propensityFloor: floor }).doublyRobust);
    expect(result.candidateScore).toBe(scoreOfflinePolicy({ rows, policy: candidate, propensityFloor: floor }).doublyRobust);
    expect(result.rowCount).toBe(2);
  });

  it('gates the verdict on minRows while still reporting the raw difference', () => {
    // With minRows met, the verdict is computed.
    const enough = compareOfflineReplay(rows, incumbent, candidate, 2, 1e-3);
    expect(enough.sufficientRows).toBe(true);
    expect(['candidate-higher', 'incumbent-higher', 'equal']).toContain(enough.comparison);
    expect(enough.candidateMinusIncumbent).toBe(enough.candidateScore! - enough.incumbentScore!);
  });

  it('returns insufficient-data below minRows even when both scores exist', () => {
    // The #7391 bridge computed the verdict from score nullness alone and
    // never consulted sufficientRows; the recut restores the source gate.
    const thin = compareOfflineReplay(rows, incumbent, candidate, 3, 1e-3);
    expect(thin.sufficientRows).toBe(false);
    expect(thin.comparison).toBe('insufficient-data');
    expect(thin.incumbentScore).not.toBeNull();
    expect(thin.candidateScore).not.toBeNull();
    expect(thin.candidateMinusIncumbent).not.toBeNull();
  });

  it('propagates the scorer validation instead of re-implementing it', () => {
    const malformed: readonly OfflineReplayRow[] = [
      { rowId: 'r1', loggedPoolId: A.poolId, loggedConsumer: A.consumer, propensity: 1.5, reward: 0.7, eligible: [A, B] },
    ];
    expect(() => compareOfflineReplay(malformed, incumbent, candidate, 1, 1e-3)).toThrow(
      'rows[0].propensity must be in (0, 1]',
    );
  });

  it('validates its own contract before touching the rows', () => {
    expect(() =>
      compareOfflineReplay(null as unknown as readonly OfflineReplayRow[], incumbent, candidate, 0, 1e-3),
    ).toThrow('minRows must be a positive finite integer');
  });
});
