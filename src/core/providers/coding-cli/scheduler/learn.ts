/**
 * Thompson-sampling contextual bandit and offline replay.
 * Given a seed, a sample is deterministic. Promotion uses doubly robust
 * replay and does not write a policy file or a GitHub issue.
 */

import { createHash } from 'node:crypto';

import type { SchedulerConfig } from './defaults.js';
import {
  armKey,
  type ArmState,
  type BanditState,
  type EligibleRef,
  type JobKind,
  type RouterOutcome,
  type SchedulerPoolId,
  type UltraConsumer,
} from './types.js';

export function priorArm(): ArmState {
  return {
    alpha: 1,
    beta: 1,
    qualityMean: 1,
    qualityM2: 0,
    latencyMean: 0,
    latencyM2: 0,
    tokenMean: 0,
    tokenM2: 0,
    tokenObservations: 0,
    observations: 0,
  };
}

export function emptyBandit(id = 'incumbent'): BanditState {
  return { id, arms: {} };
}

export function getArm(state: BanditState, key: string): ArmState {
  return state.arms[key] ?? priorArm();
}

export function hashSeed(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/** Stable 0..99 bucket. The canary is the buckets below the configured percent. */
export function canaryBucket(jobId: string, salt: string): number {
  return hashSeed(`${salt}:${jobId}`) % 100;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Posterior mean of success × quality, minus latency and token penalties. */
export function expectedValue(arm: ArmState, config: SchedulerConfig): number {
  const success = arm.alpha / (arm.alpha + arm.beta);
  const quality = arm.observations === 0 ? 1 : clamp01(arm.qualityMean);
  const latency = arm.observations === 0 ? 0 : Math.min(1, Math.max(0, arm.latencyMean) / config.latencyReferenceMs);
  const tokens = arm.tokenObservations === 0 ? 0 : Math.min(1, Math.max(0, arm.tokenMean) / config.tokenReference);
  return success * quality - config.latencyWeight * latency - config.tokenWeight * tokens;
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

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

function beta(rng: () => number, alpha: number, betaParam: number): number {
  const x = gamma(rng, alpha);
  const y = gamma(rng, betaParam);
  const total = x + y;
  return total <= 0 ? 0.5 : x / total;
}

function variance(m2: number, n: number): number {
  if (n < 2) return 0.25;
  return Math.max(m2 / (n - 1), 1e-6);
}

/** One Thompson draw: Beta success and Normal quality. Latency and tokens stay at their means. */
export function sampleValue(arm: ArmState, rng: () => number, config: SchedulerConfig): number {
  const success = clamp01(beta(rng, arm.alpha, arm.beta));
  const quality = clamp01(arm.qualityMean + Math.sqrt(variance(arm.qualityM2, arm.observations)) * normal(rng));
  const latency = arm.observations === 0 ? 0 : Math.min(1, Math.max(0, arm.latencyMean) / config.latencyReferenceMs);
  const tokens = arm.tokenObservations === 0 ? 0 : Math.min(1, Math.max(0, arm.tokenMean) / config.tokenReference);
  return success * quality - config.latencyWeight * latency - config.tokenWeight * tokens;
}

function welford(mean: number, m2: number, n: number, observation: number): { mean: number; m2: number; n: number } {
  const next = n + 1;
  const delta = observation - mean;
  const nextMean = n === 0 ? observation : mean + delta / next;
  const nextM2 = n === 0 ? 0 : m2 + delta * (observation - nextMean);
  return { mean: nextMean, m2: nextM2, n: next };
}

export function updateBandit(state: BanditState, outcome: RouterOutcome): BanditState {
  const key = armKey(outcome.jobType, outcome.poolId, outcome.consumer);
  const current = { ...getArm(state, key) };
  const success = outcome.merged && outcome.green && !outcome.reverted;
  if (success) current.alpha += 1;
  else current.beta += 1;
  const qualityObs = success ? 1 / (1 + Math.max(0, outcome.reviewRounds)) : 0;
  const quality = welford(current.qualityMean, current.qualityM2, current.observations, qualityObs);
  const latency = welford(current.latencyMean, current.latencyM2, current.observations, Math.max(0, outcome.wallMs));
  current.qualityMean = quality.mean;
  current.qualityM2 = quality.m2;
  current.latencyMean = latency.mean;
  current.latencyM2 = latency.m2;
  current.observations += 1;
  if (outcome.tokens !== null && Number.isFinite(outcome.tokens)) {
    const tokens = welford(current.tokenMean, current.tokenM2, current.tokenObservations, Math.max(0, outcome.tokens));
    current.tokenMean = tokens.mean;
    current.tokenM2 = tokens.m2;
    current.tokenObservations = tokens.n;
  }
  return { id: state.id, arms: { ...state.arms, [key]: current } };
}

export function outcomeReward(outcome: RouterOutcome, config: SchedulerConfig): number {
  const success = outcome.merged && outcome.green && !outcome.reverted;
  const quality = success ? 1 / (1 + Math.max(0, outcome.reviewRounds)) : 0;
  const latency = Math.min(1, Math.max(0, outcome.wallMs) / config.latencyReferenceMs);
  return quality - 0.25 * latency;
}

export interface ReplayRow {
  jobType: JobKind;
  loggedPool: SchedulerPoolId;
  loggedConsumer: UltraConsumer | null;
  propensity: number;
  reward: number;
  eligible: readonly EligibleRef[];
}

export function policyChoice(
  state: BanditState,
  config: SchedulerConfig,
  jobType: JobKind,
  eligible: readonly EligibleRef[],
): EligibleRef | null {
  let best: { ref: EligibleRef; value: number } | null = null;
  for (const ref of eligible) {
    const value = expectedValue(getArm(state, armKey(jobType, ref.poolId, ref.consumer)), config);
    const better = best === null || value > best.value + 1e-9
      || (Math.abs(value - best.value) <= 1e-9 && `${ref.poolId}:${ref.consumer ?? ''}` < `${best.ref.poolId}:${best.ref.consumer ?? ''}`);
    if (better) best = { ref, value };
  }
  return best?.ref ?? null;
}

export interface PolicyScore {
  ips: number;
  doublyRobust: number;
  n: number;
}

/** Inverse-propensity and doubly robust value of one policy on logged rows. */
export function evaluatePolicy(rows: readonly ReplayRow[], state: BanditState, config: SchedulerConfig): PolicyScore {
  if (rows.length === 0) return { ips: 0, doublyRobust: 0, n: 0 };
  let ips = 0;
  let doublyRobust = 0;
  for (const row of rows) {
    const chosen = policyChoice(state, config, row.jobType, row.eligible);
    const valueOf = (ref: EligibleRef | null): number => (
      ref === null ? 0 : expectedValue(getArm(state, armKey(row.jobType, ref.poolId, ref.consumer)), config)
    );
    const logged = { poolId: row.loggedPool, consumer: row.loggedConsumer };
    const match = chosen !== null && chosen.poolId === logged.poolId && chosen.consumer === logged.consumer;
    const weight = match ? 1 / Math.max(row.propensity, 1e-3) : 0;
    ips += weight * row.reward;
    doublyRobust += valueOf(chosen) + weight * (row.reward - valueOf(logged));
  }
  return { ips: ips / rows.length, doublyRobust: doublyRobust / rows.length, n: rows.length };
}

export interface Promotion {
  promoted: boolean;
  policy: BanditState;
  method: 'doubly-robust';
  incumbentScore: number;
  candidateScore: number;
  reason: string;
}

/** A candidate replaces the incumbent only when doubly robust replay is strictly better. */
export function promoteIfBetter(input: {
  incumbent: BanditState;
  candidate: BanditState;
  rows: readonly ReplayRow[];
  config: SchedulerConfig;
  minRows?: number;
}): Promotion {
  const minRows = input.minRows ?? input.config.promotionMinRows;
  if (input.rows.length < minRows) {
    return {
      promoted: false,
      policy: input.incumbent,
      method: 'doubly-robust',
      incumbentScore: 0,
      candidateScore: 0,
      reason: 'too few rows',
    };
  }
  const incumbentScore = evaluatePolicy(input.rows, input.incumbent, input.config);
  const candidateScore = evaluatePolicy(input.rows, input.candidate, input.config);
  if (candidateScore.doublyRobust > incumbentScore.doublyRobust) {
    return {
      promoted: true,
      policy: { ...input.candidate, id: input.candidate.id },
      method: 'doubly-robust',
      incumbentScore: incumbentScore.doublyRobust,
      candidateScore: candidateScore.doublyRobust,
      reason: 'replay beat the incumbent',
    };
  }
  return {
    promoted: false,
    policy: input.incumbent,
    method: 'doubly-robust',
    incumbentScore: incumbentScore.doublyRobust,
    candidateScore: candidateScore.doublyRobust,
    reason: 'replay did not beat the incumbent',
  };
}
