/**
 * Historical assignment-coefficient composition over one recorded candidate.
 * Pure: caller-supplied recorded values only. Recovered from PR #5952
 * (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886), scheduler/solve.ts
 * coefficient() and round6(). It explains a recorded score; it never authorizes
 * spend, routing, merge or work.
 *
 * Source arithmetic preserved: shadow applies only to consumer 'cloud-agent';
 * role fit (+0.05) only to review/merge/orchestration with consumer
 * 'orchestrator'; bonus = urgencyWeight * urgency; the sum keeps the source's
 * left-to-right order and is rounded with the source round6.
 *
 * Validation differences from source (the source had none):
 * - NaN, ±Infinity and non-numbers throw; the source propagated NaN.
 * - Missing or unknown role, consumer, or empty policyId throw; unknown evidence
 *   is never zeroed. `consumer: null` (no ultra consumer) is accepted.
 * - Urgency must lie in [0, 1]; the source clamped it inside loseItUrgency().
 * - Overflow to a non-finite coefficient throws; the source returned Infinity/NaN.
 * - The cloud shadow price is validated even when it is not applied.
 *
 * `contributions` are the unrounded signed terms; `coefficient` is their sum
 * rounded to six decimals, so the two can differ by rounding.
 */

import {
  CODING_CLI_ULTRA_CONSUMERS,
  isNonEmptyString,
  round6,
  type CodingCliUltraConsumer,
} from './validation.js';

export const RECORDED_COEFFICIENT_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'historical-offline',
} as const;

/** Local mirror of the scheduler roles; no import from unmerged work. */
const RECORDED_COEFFICIENT_ROLES = ['produce', 'review', 'merge', 'credential', 'orchestration'] as const;
export type RecordedCoefficientRole = (typeof RECORDED_COEFFICIENT_ROLES)[number];

/** Local mirror of the Grok Ultra consumers; `null` means no ultra consumer. */
export type RecordedCoefficientConsumer = CodingCliUltraConsumer;

export const ROLE_FIT_BONUS = 0.05;

export interface RecordedCoefficientInput {
  learnedValue: number;
  /** Recorded policy identifier that produced `learnedValue`. */
  policyId: string;
  monetaryCost: number;
  preferencePenalty: number;
  /** Explicit shadow price; applied only when consumer is 'cloud-agent'. */
  cloudShadowPrice: number;
  role: RecordedCoefficientRole;
  consumer: RecordedCoefficientConsumer | null;
  /** Already-recorded urgency in [0, 1]. */
  urgency: number;
  urgencyWeight: number;
}

export interface RecordedCoefficientResult {
  coefficient: number;
  policyId: string;
  roleFitEligible: boolean;
  /** Signed, unrounded terms: costs, penalty and shadow are negative. */
  contributions: {
    learnedValue: number;
    monetaryCost: number;
    preferencePenalty: number;
    cloudShadowPrice: number;
    roleFit: number;
    urgencyBonus: number;
  };
  provenance: typeof RECORDED_COEFFICIENT_PROVENANCE;
}

function finiteNumber(name: string, value: unknown): number {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number; unknown evidence is refused`);
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${String(value)}`);
  return value;
}

function assertRole(role: unknown): RecordedCoefficientRole {
  if (!(RECORDED_COEFFICIENT_ROLES as readonly unknown[]).includes(role)) {
    throw new TypeError(`unknown role ${String(role)}; refusing to score`);
  }
  return role as RecordedCoefficientRole;
}

function assertConsumer(consumer: unknown): RecordedCoefficientConsumer | null {
  if (consumer === null) return null;
  if (!(CODING_CLI_ULTRA_CONSUMERS as readonly unknown[]).includes(consumer)) {
    throw new TypeError(`unknown consumer ${String(consumer)}; use null for no ultra consumer`);
  }
  return consumer as RecordedCoefficientConsumer;
}

/** True only for review, merge and orchestration roles scoring the orchestrator consumer. */
export function roleFitEligible(role: RecordedCoefficientRole, consumer: RecordedCoefficientConsumer | null): boolean {
  const r = assertRole(role);
  const c = assertConsumer(consumer);
  return (r === 'review' || r === 'merge' || r === 'orchestration') && c === 'orchestrator';
}

export function recordedCoefficient(input: RecordedCoefficientInput): RecordedCoefficientResult {
  const learnedValue = finiteNumber('learnedValue', input.learnedValue);
  if (!isNonEmptyString(input.policyId)) {
    throw new TypeError('policyId must be a non-empty string; unknown policy is refused');
  }
  const monetaryCost = finiteNumber('monetaryCost', input.monetaryCost);
  const preferencePenalty = finiteNumber('preferencePenalty', input.preferencePenalty);
  const cloudShadowPrice = finiteNumber('cloudShadowPrice', input.cloudShadowPrice);
  const role = assertRole(input.role);
  const consumer = assertConsumer(input.consumer);
  const urgency = finiteNumber('urgency', input.urgency);
  if (urgency < 0 || urgency > 1) throw new RangeError(`urgency must be within [0, 1], got ${urgency}`);
  const urgencyWeight = finiteNumber('urgencyWeight', input.urgencyWeight);

  const shadow = consumer === 'cloud-agent' ? cloudShadowPrice : 0;
  const eligible = roleFitEligible(role, consumer);
  const roleFit = eligible ? ROLE_FIT_BONUS : 0;
  const urgencyBonus = urgencyWeight * urgency;

  // Source order, so rounding matches. Once a step overflows to Infinity the
  // result stays Infinity or NaN, so the two checks below cover every overflow.
  const raw = learnedValue - monetaryCost - preferencePenalty - shadow + roleFit + urgencyBonus;
  if (!Number.isFinite(raw)) throw new RangeError('recorded coefficient overflowed to a non-finite value');
  const coefficient = round6(raw);
  if (!Number.isFinite(coefficient)) throw new RangeError('recorded coefficient overflowed during six-decimal rounding');

  return {
    coefficient,
    policyId: input.policyId,
    roleFitEligible: eligible,
    contributions: {
      learnedValue,
      // `0 - x` rather than `-x` so zero inputs report +0, not -0.
      monetaryCost: 0 - monetaryCost,
      preferencePenalty: 0 - preferencePenalty,
      cloudShadowPrice: 0 - shadow,
      roleFit,
      urgencyBonus,
    },
    provenance: RECORDED_COEFFICIENT_PROVENANCE,
  };
}
