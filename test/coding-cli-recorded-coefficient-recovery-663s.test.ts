import { describe, expect, it } from 'vitest';

import {
  RECORDED_COEFFICIENT_PROVENANCE,
  ROLE_FIT_BONUS,
  recordedCoefficient,
  roleFitEligible,
  type RecordedCoefficientInput,
  type RecordedCoefficientRole,
} from '../src/core/providers/coding-cli/recorded-coefficient.js';

// Synthetic recorded inputs with plainly fake identifiers. Expected values are
// hand-computed from the source composition, not produced by a copied oracle.
const base: RecordedCoefficientInput = {
  learnedValue: 0,
  policyId: 'fake-policy-a',
  monetaryCost: 0,
  preferencePenalty: 0,
  cloudShadowPrice: 0,
  role: 'produce',
  consumer: null,
  urgency: 0,
  urgencyWeight: 0,
};

const withInput = (patch: Partial<RecordedCoefficientInput>): RecordedCoefficientInput => ({ ...base, ...patch });

describe('recordedCoefficient provenance', () => {
  it('pins the fixed source PR and SHA', () => {
    expect(RECORDED_COEFFICIENT_PROVENANCE).toEqual({
      sourcePr: 5952,
      sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      basis: 'historical-offline',
    });
    expect(recordedCoefficient(base).provenance).toBe(RECORDED_COEFFICIENT_PROVENANCE);
  });
});

describe('recordedCoefficient composition', () => {
  it('applies the cloud shadow for cloud-agent and exposes every signed term', () => {
    // 0.8 - 0.25 - 0.1 - 0.2 + 0 + (0.4 * 0.5) = 0.45
    const out = recordedCoefficient(withInput({
      learnedValue: 0.8, monetaryCost: 0.25, preferencePenalty: 0.1, cloudShadowPrice: 0.2,
      role: 'produce', consumer: 'cloud-agent', urgency: 0.5, urgencyWeight: 0.4,
    }));
    expect(out.coefficient).toBe(0.45);
    expect(out.policyId).toBe('fake-policy-a');
    expect(out.roleFitEligible).toBe(false);
    expect(out.contributions).toEqual({
      learnedValue: 0.8, monetaryCost: -0.25, preferencePenalty: -0.1, cloudShadowPrice: -0.2,
      roleFit: 0, urgencyBonus: 0.2,
    });
  });

  it('ignores the cloud shadow price for the orchestrator and null consumers', () => {
    const orchestrator = recordedCoefficient(withInput({ learnedValue: 1, cloudShadowPrice: 0.3, consumer: 'orchestrator' }));
    const none = recordedCoefficient(withInput({ learnedValue: 1, cloudShadowPrice: 0.3, consumer: null }));
    expect(orchestrator.coefficient).toBe(1);
    expect(none.coefficient).toBe(1);
    expect(orchestrator.contributions.cloudShadowPrice).toBe(0);
    expect(none.contributions.cloudShadowPrice).toBe(0);
  });

  it('applies role fit only to review, merge and orchestration roles scoring the orchestrator', () => {
    // 1 + 0.05 = 1.05
    const review = recordedCoefficient(withInput({ learnedValue: 1, role: 'review', consumer: 'orchestrator' }));
    expect(review.coefficient).toBe(1.05);
    expect(review.roleFitEligible).toBe(true);
    expect(review.contributions.roleFit).toBe(ROLE_FIT_BONUS);
  });

  it('gives no role fit to produce, and none to any role on the cloud-agent consumer', () => {
    const produce = recordedCoefficient(withInput({ learnedValue: 1, role: 'produce', consumer: 'orchestrator' }));
    expect(produce.coefficient).toBe(1);
    expect(produce.roleFitEligible).toBe(false);
    const reviewCloud = recordedCoefficient(withInput({ learnedValue: 1, role: 'review', consumer: 'cloud-agent' }));
    expect(reviewCloud.coefficient).toBe(1);
    expect(reviewCloud.roleFitEligible).toBe(false);
  });

  it('gives role fit only for the three eligible roles across both consumers', () => {
    const roles: RecordedCoefficientRole[] = ['produce', 'review', 'merge', 'credential', 'orchestration'];
    const eligible = new Set(['review', 'merge', 'orchestration']);
    for (const role of roles) {
      expect(roleFitEligible(role, 'orchestrator')).toBe(eligible.has(role));
      expect(roleFitEligible(role, 'cloud-agent')).toBe(false);
      expect(roleFitEligible(role, null)).toBe(false);
    }
  });

  it('keeps a negative learned value negative after costs and role fit', () => {
    // -0.3 - 0.1 - 0 - 0 + 0 + (0.2 * 0.25) = -0.35
    const out = recordedCoefficient(withInput({
      learnedValue: -0.3, monetaryCost: 0.1, urgency: 0.25, urgencyWeight: 0.2,
    }));
    expect(out.coefficient).toBe(-0.35);
  });

  it('reproduces zero costs exactly and reports zero terms as +0', () => {
    const out = recordedCoefficient(withInput({ learnedValue: 0.7 }));
    expect(out.coefficient).toBe(0.7);
    expect(Object.is(out.contributions.monetaryCost, 0)).toBe(true);
    expect(Object.is(out.contributions.preferencePenalty, 0)).toBe(true);
    expect(Object.is(out.contributions.cloudShadowPrice, 0)).toBe(true);
  });

  it('treats a supplied zero urgency as a zero bonus even with a large weight', () => {
    const out = recordedCoefficient(withInput({ learnedValue: 0.5, urgency: 0, urgencyWeight: 5 }));
    expect(out.coefficient).toBe(0.5);
    expect(out.contributions.urgencyBonus).toBe(0);
  });

  it('adds the full urgency weight at urgency 1', () => {
    const out = recordedCoefficient(withInput({ learnedValue: 0, urgency: 1, urgencyWeight: 0.5 }));
    expect(out.coefficient).toBe(0.5);
    expect(out.contributions.urgencyBonus).toBe(0.5);
  });
});

describe('recordedCoefficient six-decimal rounding', () => {
  it('rounds to the nearest six-decimal step as the source round6 does', () => {
    // 0.1234567 * 1e6 = 123456.7 -> 123457
    expect(recordedCoefficient(withInput({ learnedValue: 0.1234567 })).coefficient).toBe(0.123457);
    // -0.1234567 * 1e6 = -123456.7 -> -123457
    expect(recordedCoefficient(withInput({ learnedValue: -0.1234567 })).coefficient).toBe(-0.123457);
  });

  it('rounds down when the residue is below half a micro-unit', () => {
    // 0.1234564 * 1e6 = 123456.4 -> 123456
    expect(recordedCoefficient(withInput({ learnedValue: 0.1234564 })).coefficient).toBe(0.123456);
  });

  it('exposes unrounded contributions whose sum is rounded only in coefficient', () => {
    const out = recordedCoefficient(withInput({ learnedValue: 0.1234564, monetaryCost: 0 }));
    expect(out.contributions.learnedValue).toBe(0.1234564);
    expect(out.coefficient).toBe(0.123456);
  });
});

describe('recordedCoefficient refuses unknown or invalid evidence', () => {
  it('refuses missing or non-numeric numbers instead of defaulting to zero', () => {
    expect(() => recordedCoefficient({ ...base, learnedValue: undefined as unknown as number })).toThrow(TypeError);
    expect(() => recordedCoefficient({ ...base, monetaryCost: null as unknown as number })).toThrow(TypeError);
    expect(() => recordedCoefficient({ ...base, urgencyWeight: '0.5' as unknown as number })).toThrow(TypeError);
  });

  it('refuses nonfinite numbers', () => {
    expect(() => recordedCoefficient(withInput({ learnedValue: Number.NaN }))).toThrow(RangeError);
    expect(() => recordedCoefficient(withInput({ monetaryCost: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
    expect(() => recordedCoefficient(withInput({ preferencePenalty: Number.NEGATIVE_INFINITY }))).toThrow(RangeError);
    expect(() => recordedCoefficient(withInput({ cloudShadowPrice: Number.NaN }))).toThrow(RangeError);
    expect(() => recordedCoefficient(withInput({ urgencyWeight: Number.NaN }))).toThrow(RangeError);
  });

  it('validates the cloud shadow price even when it is not applied', () => {
    expect(() => recordedCoefficient(withInput({ cloudShadowPrice: Number.NaN, consumer: 'orchestrator' }))).toThrow(RangeError);
  });

  it('refuses urgency outside [0, 1]', () => {
    expect(() => recordedCoefficient(withInput({ urgency: 1.5 }))).toThrow(RangeError);
    expect(() => recordedCoefficient(withInput({ urgency: -0.1 }))).toThrow(RangeError);
  });

  it('refuses an empty or missing policy identifier', () => {
    expect(() => recordedCoefficient(withInput({ policyId: '' }))).toThrow(TypeError);
    expect(() => recordedCoefficient(withInput({ policyId: '   ' }))).toThrow(TypeError);
    expect(() => recordedCoefficient({ ...base, policyId: undefined as unknown as string })).toThrow(TypeError);
  });

  it('refuses unknown roles and consumers', () => {
    expect(() => recordedCoefficient(withInput({ role: 'deploy' as RecordedCoefficientRole }))).toThrow(TypeError);
    expect(() => recordedCoefficient(withInput({ consumer: 'unknown' as never }))).toThrow(TypeError);
    expect(() => recordedCoefficient({ ...base, consumer: undefined as unknown as null })).toThrow(TypeError);
  });

  it('refuses overflow of the sum to a non-finite value', () => {
    // 1e308 - (-1e308) = Infinity
    expect(() => recordedCoefficient(withInput({ learnedValue: 1e308, monetaryCost: -1e308 }))).toThrow(RangeError);
    // 1e308 + 1e308 bonus overflows the sum
    expect(() => recordedCoefficient(withInput({ learnedValue: 1e308, urgency: 1, urgencyWeight: 1e308 }))).toThrow(RangeError);
  });

  it('refuses overflow during six-decimal rounding', () => {
    // 1e303 is finite, but 1e303 * 1e6 overflows to Infinity inside round6
    expect(() => recordedCoefficient(withInput({ learnedValue: 1e303 }))).toThrow(RangeError);
  });
});
