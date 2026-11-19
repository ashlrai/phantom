/**
 * Offline posterior comparison over supplied candidates.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/regret.ts computeRegret()      -> comparePosteriorChoices()
 *   scheduler/learn.ts  expectedValue()      -> posteriorExpectedValue() (private)
 *   scheduler/learn.ts  getArm()/priorArm()  -> missingArms: 'prior-derived'
 *   scheduler/types.ts  armKey()             -> posteriorArmKey()
 *
 * Pure: no I/O, clock, process, routing or issue posting. The result compares
 * posterior means over the supplied candidates. It is not evidence of a better
 * counterfactual execution, current availability, quota, cost, or dispatch
 * permission (see `claims`).
 *
 * Adaptations from the source:
 *   - Pool and consumer identities are caller-supplied. The source's pool list
 *     and per-pool consumer mapping are not recovered.
 *   - Formula parameters and epsilon are required inputs, not embedded defaults.
 *   - Candidate identities must be unique (the source never had duplicates).
 *   - Identities are non-empty without NUL; a consumer is null or non-empty.
 *   - Invalid or non-finite numbers throw. The source would emit NaN.
 */

/** The posterior fields the formula reads. A source ArmState is structurally compatible. */
export interface PosteriorArmState {
  alpha: number;
  beta: number;
  qualityMean: number;
  latencyMean: number;
  tokenMean: number;
  tokenObservations: number;
  observations: number;
}

/** Explicit numeric parameters. None has a provider default here. */
export interface PosteriorFormulaParams {
  latencyWeight: number;
  latencyReferenceMs: number;
  tokenWeight: number;
  tokenReference: number;
  /** A gap must be strictly greater than epsilon to produce a comparison. */
  epsilon: number;
}

export interface PosteriorIdentity {
  poolId: string;
  consumer: string | null;
}

/** A recorded choice. Only the identity fields are read. */
export interface PosteriorOutcome extends PosteriorIdentity {
  jobId: string;
  jobType: string;
}

export interface PosteriorComparisonInput {
  /** Recorded choices, evaluated in order. */
  outcomes: readonly PosteriorOutcome[];
  /** Posterior arms keyed by `posteriorArmKey(jobType, poolId, consumer)`. */
  arms: Readonly<Record<string, PosteriorArmState>>;
  /** Ordered alternatives. A tie goes to the earliest candidate. */
  candidates: readonly PosteriorIdentity[];
  formula: PosteriorFormulaParams;
  /**
   * 'exclude': a missing arm drops that candidate, or the whole job when the
   * chosen arm is missing. 'prior-derived': use the source prior, labelled.
   */
  missingArms: 'exclude' | 'prior-derived';
}

export type PosteriorValueSource = 'measured' | 'prior-derived';

/**
 * One comparison. Names follow the source RegretItem, plus `recordIndex` and
 * the value sources. `regret` is a posterior gap, not a measured loss.
 */
export interface PosteriorComparison {
  recordIndex: number;
  jobId: string;
  jobType: string;
  chosenPool: string;
  chosenConsumer: string | null;
  chosenValue: number;
  chosenValueSource: PosteriorValueSource;
  betterPool: string;
  betterConsumer: string | null;
  betterValue: number;
  betterValueSource: PosteriorValueSource;
  regret: number;
}

export interface PosteriorComparisonResult {
  basis: 'posterior-over-supplied-candidates';
  /** Fixed. A comparison establishes none of these. */
  claims: {
    counterfactualExecution: false;
    currentAvailability: false;
    quota: false;
    cost: false;
    dispatchPermission: false;
  };
  comparisons: PosteriorComparison[];
}

/** The source priorArm(): what an unmeasured arm reads as. Used only when labelled. */
const SOURCE_PRIOR: PosteriorArmState = {
  alpha: 1,
  beta: 1,
  qualityMean: 1,
  latencyMean: 0,
  tokenMean: 0,
  tokenObservations: 0,
  observations: 0,
};

/** Same layout as the source armKey(): `jobType NUL poolId NUL consumer-or-empty`. */
export function posteriorArmKey(jobType: string, poolId: string, consumer: string | null): string {
  return `${jobType}\u0000${poolId}\u0000${consumer ?? ''}`;
}

/** Same expression order as the source expectedValue(), so the floats match. */
function posteriorExpectedValue(arm: PosteriorArmState, formula: PosteriorFormulaParams): number {
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const success = arm.alpha / (arm.alpha + arm.beta);
  const quality = arm.observations === 0 ? 1 : clamp01(arm.qualityMean);
  const latency = arm.observations === 0 ? 0 : Math.min(1, Math.max(0, arm.latencyMean) / formula.latencyReferenceMs);
  const tokens = arm.tokenObservations === 0 ? 0 : Math.min(1, Math.max(0, arm.tokenMean) / formula.tokenReference);
  return success * quality - formula.latencyWeight * latency - formula.tokenWeight * tokens;
}

function num(value: unknown, name: string, ok: (n: number) => boolean, rule: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !ok(value)) {
    throw new RangeError(`${name} must be a finite number ${rule}`);
  }
  return value;
}

const nonNegative = (value: unknown, name: string) => num(value, name, (n) => n >= 0, '>= 0');
const positive = (value: unknown, name: string) => num(value, name, (n) => n > 0, '> 0');

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || value.includes('\u0000')) {
    throw new TypeError(`${name} must be a non-empty string without NUL`);
  }
  return value;
}

function consumerOf(value: unknown, name: string): string | null {
  return value === null ? null : identifier(value, name);
}

function validateArm(arm: PosteriorArmState, key: string): void {
  positive(arm.alpha, `arms[${key}].alpha`);
  positive(arm.beta, `arms[${key}].beta`);
  if (!Number.isFinite(arm.alpha + arm.beta)) throw new RangeError(`arms[${key}].alpha + beta must be finite`);
  num(arm.qualityMean, `arms[${key}].qualityMean`, () => true, '');
  num(arm.latencyMean, `arms[${key}].latencyMean`, () => true, '');
  num(arm.tokenMean, `arms[${key}].tokenMean`, () => true, '');
  nonNegative(arm.observations, `arms[${key}].observations`);
  nonNegative(arm.tokenObservations, `arms[${key}].tokenObservations`);
}

/**
 * Compare each recorded choice with its best alternative among `candidates`.
 *
 * Per outcome, in order: the chosen identity is excluded; the best candidate has
 * the highest value, and a tie keeps the earliest; a comparison is emitted only
 * when best - chosen is strictly greater than epsilon.
 *
 * Duplicate job records (same jobId) are not collapsed. Each row is evaluated
 * on its own, as in the source; `recordIndex` tells them apart.
 *
 * Empty outcomes, empty candidates, or no alternative that beats the chosen
 * identity all give an empty `comparisons`. Invalid input throws. Never mutates.
 */
export function comparePosteriorChoices(input: PosteriorComparisonInput): PosteriorComparisonResult {
  const { formula } = input;
  nonNegative(formula.latencyWeight, 'formula.latencyWeight');
  positive(formula.latencyReferenceMs, 'formula.latencyReferenceMs');
  nonNegative(formula.tokenWeight, 'formula.tokenWeight');
  positive(formula.tokenReference, 'formula.tokenReference');
  nonNegative(formula.epsilon, 'formula.epsilon');
  if (input.missingArms !== 'exclude' && input.missingArms !== 'prior-derived') {
    throw new TypeError("missingArms must be 'exclude' or 'prior-derived'");
  }
  for (const [key, arm] of Object.entries(input.arms)) validateArm(arm, key);

  const seen = new Set<string>();
  const candidates = input.candidates.map((c, i): PosteriorIdentity => {
    const identity = {
      poolId: identifier(c.poolId, `candidates[${i}].poolId`),
      consumer: consumerOf(c.consumer, `candidates[${i}].consumer`),
    };
    const id = posteriorArmKey('', identity.poolId, identity.consumer);
    if (seen.has(id)) throw new RangeError(`candidates[${i}] duplicates an earlier candidate identity`);
    seen.add(id);
    return identity;
  });

  const valueOf = (jobType: string, poolId: string, consumer: string | null) => {
    const key = posteriorArmKey(jobType, poolId, consumer);
    if (Object.prototype.hasOwnProperty.call(input.arms, key)) {
      return { value: posteriorExpectedValue(input.arms[key] as PosteriorArmState, formula), source: 'measured' as const };
    }
    if (input.missingArms === 'prior-derived') {
      return { value: posteriorExpectedValue(SOURCE_PRIOR, formula), source: 'prior-derived' as const };
    }
    return null;
  };

  const comparisons: PosteriorComparison[] = [];
  input.outcomes.forEach((outcome, recordIndex) => {
    const at = (field: string) => `outcomes[${recordIndex}].${field}`;
    const jobId = identifier(outcome.jobId, at('jobId'));
    const jobType = identifier(outcome.jobType, at('jobType'));
    const chosenPool = identifier(outcome.poolId, at('poolId'));
    const chosenConsumer = consumerOf(outcome.consumer, at('consumer'));

    const chosen = valueOf(jobType, chosenPool, chosenConsumer);
    if (chosen === null) return;

    let best: { poolId: string; consumer: string | null; value: number; source: PosteriorValueSource } | null = null;
    for (const candidate of candidates) {
      if (candidate.poolId === chosenPool && candidate.consumer === chosenConsumer) continue;
      const scored = valueOf(jobType, candidate.poolId, candidate.consumer);
      if (scored !== null && (best === null || scored.value > best.value)) {
        best = { poolId: candidate.poolId, consumer: candidate.consumer, ...scored };
      }
    }
    if (best === null || best.value - chosen.value <= formula.epsilon) return;

    comparisons.push({
      recordIndex,
      jobId,
      jobType,
      chosenPool,
      chosenConsumer,
      chosenValue: chosen.value,
      chosenValueSource: chosen.source,
      betterPool: best.poolId,
      betterConsumer: best.consumer,
      betterValue: best.value,
      betterValueSource: best.source,
      regret: best.value - chosen.value,
    });
  });

  return {
    basis: 'posterior-over-supplied-candidates',
    claims: { counterfactualExecution: false, currentAvailability: false, quota: false, cost: false, dispatchPermission: false },
    comparisons,
  };
}
