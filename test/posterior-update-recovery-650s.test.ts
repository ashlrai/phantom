import { describe, expect, it } from 'vitest';

import { comparePosteriorChoices, posteriorArmKey } from '../src/core/providers/coding-cli/posterior-comparison.js';
import {
  posteriorPrior,
  updatePosteriorArm,
  type PosteriorUpdateOutcome,
} from '../src/core/providers/coding-cli/posterior-update.js';

const ok: PosteriorUpdateOutcome = { merged: true, green: true, reverted: false, reviewRounds: 0, wallMs: 100, tokens: 50 };
const fold = (outcomes: PosteriorUpdateOutcome[]) => outcomes.reduce(updatePosteriorArm, posteriorPrior());

describe('posterior update recovery (650S)', () => {
  it('prior matches the source priorArm', () => {
    expect(posteriorPrior()).toEqual({
      alpha: 1, beta: 1, qualityMean: 1, qualityM2: 0, latencyMean: 0, latencyM2: 0,
      tokenMean: 0, tokenM2: 0, tokenObservations: 0, observations: 0,
    });
    expect(posteriorPrior()).not.toBe(posteriorPrior());
  });

  it('success, failure and revert follow the source rule', () => {
    const win = updatePosteriorArm(posteriorPrior(), { ...ok, reviewRounds: 3 });
    expect(win).toMatchObject({ alpha: 2, beta: 1, qualityMean: 0.25, observations: 1, latencyMean: 100, tokenMean: 50 });
    for (const bad of [{ merged: false }, { green: false }, { reverted: true }]) {
      const lost = updatePosteriorArm(posteriorPrior(), { ...ok, ...bad });
      expect(lost).toMatchObject({ alpha: 1, beta: 2, qualityMean: 0, observations: 1 });
    }
  });

  it('keeps Welford mean and M2 over several observations', () => {
    const arm = fold([
      { ...ok, reviewRounds: 0, wallMs: 100 },
      { ...ok, reviewRounds: 1, wallMs: 200 },
      { ...ok, merged: false, wallMs: 300 },
    ]);
    // quality observations 1, 0.5, 0; latency 100, 200, 300
    expect(arm.qualityMean).toBeCloseTo(0.5, 12);
    expect(arm.qualityM2).toBeCloseTo(0.5, 12);
    expect(arm.latencyMean).toBeCloseTo(200, 12);
    expect(arm.latencyM2).toBeCloseTo(20000, 9);
    expect([arm.alpha, arm.beta, arm.observations]).toEqual([3, 2, 3]);
  });

  it('counts tokens independently; null is unknown, not zero', () => {
    const arm = fold([
      { ...ok, tokens: 10 },
      { ...ok, tokens: null },
      { ...ok, tokens: 30 },
    ]);
    expect(arm.observations).toBe(3);
    expect(arm.tokenObservations).toBe(2);
    expect(arm.tokenMean).toBe(20);
    expect(arm.tokenM2).toBe(200);
    const unknownOnly = updatePosteriorArm(posteriorPrior(), { ...ok, tokens: null });
    expect(unknownOnly).toMatchObject({ tokenMean: 0, tokenM2: 0, tokenObservations: 0, observations: 1 });
  });

  it('clamps recorded negatives to zero as the source does', () => {
    const arm = updatePosteriorArm(posteriorPrior(), { ...ok, reviewRounds: -4, wallMs: -5, tokens: -6 });
    expect(arm).toMatchObject({ qualityMean: 1, latencyMean: 0, tokenMean: 0, tokenObservations: 1 });
  });

  it('does not mutate the input arm', () => {
    const arm = Object.freeze(posteriorPrior());
    const next = updatePosteriorArm(arm, ok);
    expect(next).not.toBe(arm);
    expect(arm).toEqual(posteriorPrior());
  });

  it('rejects invalid numbers, counts and arms before producing a result', () => {
    const p = posteriorPrior();
    for (const bad of [NaN, Infinity, -Infinity, '1' as unknown as number, undefined as unknown as number]) {
      expect(() => updatePosteriorArm(p, { ...ok, wallMs: bad })).toThrow(RangeError);
      expect(() => updatePosteriorArm(p, { ...ok, reviewRounds: bad })).toThrow(RangeError);
      expect(() => updatePosteriorArm(p, { ...ok, tokens: bad })).toThrow(RangeError);
    }
    expect(() => updatePosteriorArm(p, { ...ok, merged: 1 as unknown as boolean })).toThrow(TypeError);
    for (const patch of [
      { alpha: 0 }, { beta: NaN }, { alpha: Infinity }, { qualityMean: NaN }, { latencyM2: -1 },
      { observations: -1 }, { observations: 1.5 }, { tokenObservations: 1 }, { tokenM2: Infinity },
    ]) {
      expect(() => updatePosteriorArm({ ...p, ...patch }, ok)).toThrow(RangeError);
    }
  });

  it('feeds comparePosteriorChoices through its structural contract', () => {
    const weak = fold([{ ...ok, merged: false }, { ...ok, green: false }]);
    const strong = fold([ok, ok, ok]);
    const result = comparePosteriorChoices({
      outcomes: [{ jobId: 'job-fake-1', jobType: 'coding', poolId: 'pool-a', consumer: null }],
      arms: {
        [posteriorArmKey('coding', 'pool-a', null)]: weak,
        [posteriorArmKey('coding', 'pool-b', null)]: strong,
      },
      candidates: [{ poolId: 'pool-a', consumer: null }, { poolId: 'pool-b', consumer: null }],
      formula: { latencyWeight: 0, latencyReferenceMs: 1000, tokenWeight: 0, tokenReference: 1000, epsilon: 0 },
      missingArms: 'exclude',
    });
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({ chosenPool: 'pool-a', betterPool: 'pool-b', chosenValueSource: 'measured' });
    expect(result.comparisons[0]?.regret).toBeCloseTo(0.8, 12);
  });
});
