/**
 * Offline posterior update for one supplied arm.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/learn.ts priorArm()      -> posteriorPrior()
 *   scheduler/learn.ts welford()       -> welford() (private)
 *   scheduler/learn.ts updateBandit()  -> updatePosteriorArm()
 *   scheduler/types.ts ArmState        -> PosteriorUpdateArm (structurally a superset of
 *                                         PosteriorArmState in posterior-comparison.ts)
 *   scheduler/types.ts RouterOutcome   -> PosteriorUpdateOutcome (only the fields read)
 *
 * Pure and immutable: no I/O, clock, environment, sampling, routing or defaults
 * beyond the source prior. The caller owns arm identities (see
 * `posteriorArmKey` in posterior-comparison.ts) and persistence. The source arm
 * registry, pool types and `BanditState` wrapper are not recovered. Deriving
 * statistics here does not change any live router or grant dispatch permission.
 *
 * Divergences from the source:
 *   - Non-finite or non-numeric `wallMs`, `reviewRounds` or `tokens` throw. The
 *     source let NaN into latency/quality and silently skipped non-finite tokens.
 *   - Boolean flags must be booleans; `tokens` must be a number or null (not undefined).
 *   - An arm is validated first: alpha/beta finite and > 0, counts non-negative
 *     integers, means and M2 finite, M2 >= 0, tokenObservations <= observations.
 *   - Retained from the source: negative `wallMs`/`tokens` clamp to 0 and negative
 *     `reviewRounds` clamp to 0 (a recorded negative is treated as zero, not rejected).
 *   - Returns a new arm only; the source's `{ id, arms }` wrapper is the caller's.
 */

export interface PosteriorUpdateArm {
  alpha: number;
  beta: number;
  qualityMean: number;
  qualityM2: number;
  latencyMean: number;
  latencyM2: number;
  tokenMean: number;
  tokenM2: number;
  tokenObservations: number;
  observations: number;
}

export interface PosteriorUpdateOutcome {
  merged: boolean;
  green: boolean;
  reverted: boolean;
  reviewRounds: number;
  wallMs: number;
  /** null means unknown (not zero): token statistics are left untouched. */
  tokens: number | null;
}

/** The source priorArm(): Beta(1, 1), quality 1, no observations. */
export function posteriorPrior(): PosteriorUpdateArm {
  return {
    alpha: 1, beta: 1, qualityMean: 1, qualityM2: 0, latencyMean: 0, latencyM2: 0,
    tokenMean: 0, tokenM2: 0, tokenObservations: 0, observations: 0,
  };
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
  return value;
}

function count(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value as number;
}

function validateArm(arm: PosteriorUpdateArm): void {
  for (const name of ['alpha', 'beta'] as const) {
    if (finite(arm[name], `arm.${name}`) <= 0) throw new RangeError(`arm.${name} must be > 0`);
  }
  for (const name of ['qualityMean', 'latencyMean', 'tokenMean'] as const) finite(arm[name], `arm.${name}`);
  for (const name of ['qualityM2', 'latencyM2', 'tokenM2'] as const) {
    if (finite(arm[name], `arm.${name}`) < 0) throw new RangeError(`arm.${name} must be >= 0`);
  }
  const observations = count(arm.observations, 'arm.observations');
  if (count(arm.tokenObservations, 'arm.tokenObservations') > observations) {
    throw new RangeError('arm.tokenObservations must not exceed arm.observations');
  }
}

/** Same expression order as the source welford(), so the floats match. */
function welford(mean: number, m2: number, n: number, observation: number): { mean: number; m2: number; n: number } {
  const next = n + 1;
  const delta = observation - mean;
  const nextMean = n === 0 ? observation : mean + delta / next;
  const nextM2 = n === 0 ? 0 : m2 + delta * (observation - nextMean);
  return { mean: nextMean, m2: nextM2, n: next };
}

/**
 * Fold one recorded outcome into `arm`. Success is merged AND green AND not
 * reverted: alpha + 1, quality observation 1 / (1 + max(0, reviewRounds)).
 * Otherwise beta + 1 and quality observation 0. Never mutates `arm`.
 */
export function updatePosteriorArm(arm: PosteriorUpdateArm, outcome: PosteriorUpdateOutcome): PosteriorUpdateArm {
  validateArm(arm);
  for (const name of ['merged', 'green', 'reverted'] as const) {
    if (typeof outcome[name] !== 'boolean') throw new TypeError(`outcome.${name} must be a boolean`);
  }
  const reviewRounds = finite(outcome.reviewRounds, 'outcome.reviewRounds');
  const wallMs = finite(outcome.wallMs, 'outcome.wallMs');
  const tokens = outcome.tokens === null ? null : finite(outcome.tokens, 'outcome.tokens');

  const success = outcome.merged && outcome.green && !outcome.reverted;
  const quality = welford(arm.qualityMean, arm.qualityM2, arm.observations, success ? 1 / (1 + Math.max(0, reviewRounds)) : 0);
  const latency = welford(arm.latencyMean, arm.latencyM2, arm.observations, Math.max(0, wallMs));
  const next: PosteriorUpdateArm = {
    ...arm,
    alpha: arm.alpha + (success ? 1 : 0),
    beta: arm.beta + (success ? 0 : 1),
    qualityMean: quality.mean,
    qualityM2: quality.m2,
    latencyMean: latency.mean,
    latencyM2: latency.m2,
    observations: arm.observations + 1,
  };
  if (tokens !== null) {
    const t = welford(arm.tokenMean, arm.tokenM2, arm.tokenObservations, Math.max(0, tokens));
    next.tokenMean = t.mean;
    next.tokenM2 = t.m2;
    next.tokenObservations = t.n;
  }
  return next;
}
