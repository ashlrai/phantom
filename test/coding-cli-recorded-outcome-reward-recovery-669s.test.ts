import { describe, expect, it } from 'vitest';

import {
  calculateRecordedOutcomeReward,
  type RecordedOutcomeRewardInput,
} from '../src/core/providers/coding-cli/recorded-outcome-reward.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) outcomeReward().
// Expected rewards are hand-calculated from quality - 0.25 * latency; all inputs are synthetic.

const REF = 600_000;

function outcome(overrides: Partial<RecordedOutcomeRewardInput> = {}): RecordedOutcomeRewardInput {
  return { merged: true, green: true, reverted: false, reviewRounds: 0, wallMs: 0, latencyReferenceMs: REF, ...overrides };
}

describe('calculateRecordedOutcomeReward', () => {
  it('green merged success at zero latency has reward 1', () => {
    expect(calculateRecordedOutcomeReward(outcome())).toEqual({ reward: 1, quality: 1, latency: 0, provenance: 'historical-offline' });
  });

  it('review rounds reduce quality: 2 rounds gives quality 1/3', () => {
    const r = calculateRecordedOutcomeReward(outcome({ reviewRounds: 2 }));
    expect(r.quality).toBeCloseTo(1 / 3, 12);
    expect(r.reward).toBeCloseTo(1 / 3, 12);
  });

  it('review rounds reduce quality and latency still penalizes: 1 round at half reference is 0.5 - 0.125 = 0.375', () => {
    const r = calculateRecordedOutcomeReward(outcome({ reviewRounds: 1, wallMs: 300_000 }));
    expect(r.quality).toBe(0.5);
    expect(r.latency).toBe(0.5);
    expect(r.reward).toBeCloseTo(0.375, 12);
  });

  it('a failed check (green false) has quality 0 and reward -0.25 at reference latency', () => {
    const r = calculateRecordedOutcomeReward(outcome({ green: false, wallMs: REF }));
    expect(r).toEqual({ reward: -0.25, quality: 0, latency: 1, provenance: 'historical-offline' });
  });

  it('an unmerged outcome has quality 0 and reward -0.125 at half reference latency', () => {
    const r = calculateRecordedOutcomeReward(outcome({ merged: false, wallMs: 300_000 }));
    expect(r.quality).toBe(0);
    expect(r.reward).toBeCloseTo(-0.125, 12);
  });

  it('a reverted outcome has quality 0 even when merged and green: reward -0.125 at half latency', () => {
    const r = calculateRecordedOutcomeReward(outcome({ reverted: true, wallMs: 300_000 }));
    expect(r.quality).toBe(0);
    expect(r.reward).toBeCloseTo(-0.125, 12);
  });

  it('a failed outcome with zero latency has reward exactly 0', () => {
    expect(calculateRecordedOutcomeReward(outcome({ green: false })).reward).toBe(0);
  });

  it('latency saturates at 1 beyond the reference: 10x reference adds only -0.25', () => {
    const r = calculateRecordedOutcomeReward(outcome({ reviewRounds: 1, wallMs: 6_000_000 }));
    expect(r.latency).toBe(1);
    expect(r.reward).toBeCloseTo(0.25, 12);
  });

  it('negative wallMs and reviewRounds clamp to 0 instead of rejecting', () => {
    const r = calculateRecordedOutcomeReward(outcome({ reviewRounds: -3, wallMs: -5_000 }));
    expect(r).toEqual({ reward: 1, quality: 1, latency: 0, provenance: 'historical-offline' });
    expect(calculateRecordedOutcomeReward(outcome({ green: false, wallMs: -5_000 })).reward).toBe(0);
  });

  it('rejects non-finite numeric fields', () => {
    expect(() => calculateRecordedOutcomeReward(outcome({ reviewRounds: Number.NaN }))).toThrow(RangeError);
    expect(() => calculateRecordedOutcomeReward(outcome({ reviewRounds: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
    expect(() => calculateRecordedOutcomeReward(outcome({ wallMs: Number.NaN }))).toThrow(RangeError);
    expect(() => calculateRecordedOutcomeReward(outcome({ wallMs: Number.NEGATIVE_INFINITY }))).toThrow(RangeError);
  });

  it('rejects nonpositive or non-finite latencyReferenceMs', () => {
    for (const latencyReferenceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateRecordedOutcomeReward(outcome({ latencyReferenceMs }))).toThrow(RangeError);
    }
  });

  it('rejects non-boolean flags with TypeError, including truthy non-booleans', () => {
    const bad: Array<Partial<Record<'merged' | 'green' | 'reverted', unknown>>> = [
      { merged: 1 }, { green: 'true' }, { reverted: undefined }, { merged: null },
    ];
    for (const override of bad) {
      expect(() => calculateRecordedOutcomeReward({ ...outcome(), ...(override as Partial<RecordedOutcomeRewardInput>) })).toThrow(TypeError);
    }
  });

  it('does not mutate a frozen input and does not throw on it', () => {
    const input = Object.freeze(outcome({ reviewRounds: 2, wallMs: 300_000 }));
    const before = JSON.stringify(input);
    expect(() => calculateRecordedOutcomeReward(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is deterministic across repeated calls', () => {
    const input = outcome({ reviewRounds: 3, wallMs: 123_456 });
    const first = calculateRecordedOutcomeReward(input);
    for (let i = 0; i < 5; i += 1) expect(calculateRecordedOutcomeReward(input)).toEqual(first);
  });
});
