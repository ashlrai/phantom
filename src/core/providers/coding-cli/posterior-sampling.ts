/**
 * Seeded offline Thompson draw for one supplied posterior arm.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/learn.ts mulberry32()    -> mulberry32() imported from core/eval/router-eval.ts
 *                                         (same algorithm and constants; not copied)
 *   scheduler/learn.ts clamp01()       -> clamp01() (private)
 *   scheduler/learn.ts normal()        -> normal() (private)
 *   scheduler/learn.ts gamma()         -> gamma() (private)
 *   scheduler/learn.ts beta()          -> betaDraw() (private; renamed so it does not shadow arm.beta)
 *   scheduler/learn.ts variance()      -> posteriorVariance() (private)
 *   scheduler/learn.ts sampleValue()   -> samplePosteriorValue()
 *   scheduler/types.ts ArmState        -> PosteriorUpdateArm (posterior-update.ts)
 *   scheduler/defaults.ts SchedulerConfig latency/token fields -> PosteriorSamplingParams
 *
 * The draw is Beta(alpha, beta) success times Normal quality, minus the latency
 * and token penalties at their posterior means. The random stream is the source
 * mulberry32 generator, consumed in the source order (success gammas first, then
 * the two quality normals), so the same seed and arm give the same float.
 *
 * Not recovered: hashSeed/canaryBucket (the caller supplies the seed), the
 * scheduler defaults, expectedValue/policyChoice, replay and promotion, pool and
 * consumer identities, and any router, canary or dispatch hook. The sample is a
 * modelled offline score. It is not observed performance and grants no execution
 * authority or eligibility.
 *
 * Deliberate validation differences from the source (which had none):
 *   - Non-finite or non-positive alpha/beta, non-finite means, negative M2,
 *     non-integer or negative counts and tokenObservations > observations throw.
 *   - Latency and token reference denominators must be finite and > 0. The source
 *     divided by whatever it was given.
 *   - A seed must be an integer in [0, 2^32 - 1]. The source's `seed >>> 0` would
 *     silently wrap other values.
 *   - With tokenObservations 0 the token statistics must be zero. A non-zero token
 *     mean with no observations would be a manufactured observation.
 *   - Unknown tokens add no token penalty, exactly as in the source.
 */

import { mulberry32 } from '../../eval/router-eval.js';
import type { PosteriorUpdateArm } from './posterior-update.js';
import {
  assertFiniteNumber,
  clamp01,
  isRecord,
  validatePosteriorArmState,
} from './validation.js';

/** Caller-supplied numeric formula inputs. There are no defaults. */
export interface PosteriorSamplingParams {
  latencyWeight: number;
  latencyReferenceMs: number;
  tokenWeight: number;
  tokenReference: number;
}

export class PosteriorSamplingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PosteriorSamplingError';
  }
}

const MAX_SEED = 0xffffffff;
const samplingError = (message: string): Error => new PosteriorSamplingError(message);

/** Throws PosteriorSamplingError unless `arm` is a state the source could have produced. */
function validatePosteriorSamplingArm(arm: PosteriorUpdateArm): void {
  validatePosteriorArmState(arm, samplingError, { requireZeroTokensWhenUnobserved: true });
}

/** Throws PosteriorSamplingError unless the formula parameters are finite with positive reference denominators. */
function validatePosteriorSamplingParams(params: PosteriorSamplingParams): void {
  assertFiniteNumber(params.latencyWeight, 'params.latencyWeight', samplingError);
  assertFiniteNumber(params.tokenWeight, 'params.tokenWeight', samplingError);
  for (const name of ['latencyReferenceMs', 'tokenReference'] as const) {
    if (assertFiniteNumber(params[name], `params.${name}`, samplingError) <= 0) {
      throw new PosteriorSamplingError(`params.${name} must be > 0`);
    }
  }
}

/** Validates the seed as a uint32 so the generator never truncates it silently. */
function validatePosteriorSeed(seed: unknown): number {
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > MAX_SEED) {
    throw new PosteriorSamplingError(`seed must be an integer in [0, ${MAX_SEED}]`);
  }
  return seed as number;
}

/** Box-Muller standard normal, as in the source. */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia-Tsang gamma sampler, as in the source. */
function gamma(rng: () => number, shape: number): number {
  if (shape < 1) return gamma(rng, shape + 1) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let x = 0;
    let v = 0;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return shape;
}

function betaDraw(rng: () => number, alpha: number, betaParam: number): number {
  const x = gamma(rng, alpha);
  const y = gamma(rng, betaParam);
  const total = x + y;
  return total <= 0 ? 0.5 : x / total;
}

/** Source variance(): Bessel-corrected M2, with the source's 0.25 prior and 1e-6 floor. */
function posteriorVariance(m2: number, n: number): number {
  if (n < 2) return 0.25;
  return Math.max(m2 / (n - 1), 1e-6);
}

/**
 * One seeded Thompson draw: Beta success times Normal quality, minus the latency
 * and token penalties. Latency and tokens are not sampled; they use their posterior
 * means, and a penalty is zero when there is no observation. Pure: `arm` and
 * `params` are read, never written, and the same inputs always return the same number.
 */
export function samplePosteriorValue(arm: PosteriorUpdateArm, params: PosteriorSamplingParams, seed: number): number {
  validatePosteriorSamplingArm(arm);
  validatePosteriorSamplingParams(params);
  const rng = mulberry32(validatePosteriorSeed(seed));
  const success = clamp01(betaDraw(rng, arm.alpha, arm.beta));
  const quality = clamp01(arm.qualityMean + Math.sqrt(posteriorVariance(arm.qualityM2, arm.observations)) * normal(rng));
  const latency = arm.observations === 0 ? 0 : Math.min(1, Math.max(0, arm.latencyMean) / params.latencyReferenceMs);
  const tokens = arm.tokenObservations === 0 ? 0 : Math.min(1, Math.max(0, arm.tokenMean) / params.tokenReference);
  return success * quality - params.latencyWeight * latency - params.tokenWeight * tokens;
}

/** The one-arm evidence file the CLI reads. Keys are strict: anything unknown is refused. */
export interface PosteriorSampleEvidence {
  seed: number;
  params: PosteriorSamplingParams;
  arm: PosteriorUpdateArm;
}

export interface PosteriorSampleReport {
  sampledValue: number;
  seed: number;
  /** `prior` when the arm has no observations, otherwise `measured`. */
  armBasis: 'prior' | 'measured';
  /** `unknown` when no token was observed, so no token penalty applies. */
  tokenBasis: 'observed' | 'unknown';
  basis: 'offline-modelled';
  observedPerformanceClaimed: false;
  grantsExecutionAuthority: false;
  eligibility: 'not-evaluated';
}

const ARM_KEYS = [
  'alpha', 'beta', 'qualityMean', 'qualityM2', 'latencyMean', 'latencyM2',
  'tokenMean', 'tokenM2', 'tokenObservations', 'observations',
] as const;
const PARAM_KEYS = ['latencyWeight', 'latencyReferenceMs', 'tokenWeight', 'tokenReference'] as const;

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PosteriorSamplingError(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new PosteriorSamplingError(`${path} has unknown key ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new PosteriorSamplingError(`${path}.${key} is required`);
  }
  return value;
}

/** Parses and validates raw JSON into evidence. Throws PosteriorSamplingError on any shape or value problem. */
export function parsePosteriorSampleEvidence(raw: unknown): PosteriorSampleEvidence {
  const root = exactObject(raw, ['seed', 'params', 'arm'], 'evidence');
  const seed = validatePosteriorSeed(root.seed);
  const params = exactObject(root.params, PARAM_KEYS, 'params') as unknown as PosteriorSamplingParams;
  const arm = exactObject(root.arm, ARM_KEYS, 'arm') as unknown as PosteriorUpdateArm;
  validatePosteriorSamplingParams(params);
  validatePosteriorSamplingArm(arm);
  return { seed, params: { ...params }, arm: { ...arm } };
}

/** Builds the report for one draw. The basis fields say what the number is and is not. */
export function reportPosteriorSample(evidence: PosteriorSampleEvidence): PosteriorSampleReport {
  return {
    sampledValue: samplePosteriorValue(evidence.arm, evidence.params, evidence.seed),
    seed: evidence.seed,
    armBasis: evidence.arm.observations === 0 ? 'prior' : 'measured',
    tokenBasis: evidence.arm.tokenObservations === 0 ? 'unknown' : 'observed',
    basis: 'offline-modelled',
    observedPerformanceClaimed: false,
    grantsExecutionAuthority: false,
    eligibility: 'not-evaluated',
  };
}
