/**
 * Offline per-job regret over caller-supplied evidence. For each recorded
 * outcome, reports when another (pool, consumer) arm has a higher posterior
 * expected value than the arm that ran the job, by more than epsilon.
 *
 * Recovered from PR #5952 scheduler/regret.ts (source head
 * 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886). The scheduler modules it imported
 * are not on master, so the minimal inputs are declared here.
 *
 * Pure: no file, network, home, environment or process access. Writers are
 * not restored. Alternatives are modelled scores from recorded evidence, not
 * proof that a pool is currently eligible or has quota.
 */

export const REGRET_REPORT_SCHEMA = 'fleet.coding-regret.v1';
export const REGRET_SOURCE = 'posterior' as const;
export const REGRET_NOTICE =
  'modelled posterior scores from the supplied evidence only; alternatives are not proof of current eligibility, quota or availability';
/** Same default as the source computeRegret. */
export const DEFAULT_REGRET_EPSILON = 1e-6;

/** Pool order matters: on an exact tie the earlier candidate wins, as in the source. */
export const REGRET_POOL_IDS = [
  'codex-primary',
  'codex-secondary',
  'claude',
  'devin',
  'grok-build',
  'local',
  'grok-ultra-weekly',
  'metered',
] as const;
export type RegretPoolId = (typeof REGRET_POOL_IDS)[number];

/** Consumers of the single Grok Ultra weekly limit. They are separate arms, not pools. */
export const REGRET_ULTRA_CONSUMERS = ['orchestrator', 'cloud-agent'] as const;
export type RegretConsumer = (typeof REGRET_ULTRA_CONSUMERS)[number];

export const REGRET_JOB_KINDS = [
  'coding',
  'investigation',
  'test-fixing',
  'research',
  'orchestration',
  'review',
  'merge-decision',
] as const;
export type RegretJobKind = (typeof REGRET_JOB_KINDS)[number];

export interface RegretScoringConfig {
  latencyWeight: number;
  latencyReferenceMs: number;
  tokenWeight: number;
  tokenReference: number;
}

export interface RegretArmEvidence {
  jobType: RegretJobKind;
  poolId: RegretPoolId;
  consumer: RegretConsumer | null;
  alpha: number;
  beta: number;
  qualityMean: number;
  latencyMean: number;
  tokenMean: number;
  observations: number;
  tokenObservations: number;
}

export interface RegretOutcomeEvidence {
  jobId: string;
  jobType: RegretJobKind;
  poolId: RegretPoolId;
  consumer: RegretConsumer | null;
}

export interface RegretEvidence {
  outcomes: readonly RegretOutcomeEvidence[];
  arms: readonly RegretArmEvidence[];
  config: RegretScoringConfig & { epsilon: number };
}

export interface RegretItem {
  jobId: string;
  jobType: RegretJobKind;
  chosenPool: RegretPoolId;
  chosenConsumer: RegretConsumer | null;
  betterPool: RegretPoolId;
  betterConsumer: RegretConsumer | null;
  chosenValue: number;
  betterValue: number;
  regret: number;
}

export interface RegretReport {
  schema: typeof REGRET_REPORT_SCHEMA;
  source: typeof REGRET_SOURCE;
  postIssues: false;
  notice: string;
  epsilon: number;
  summary: {
    outcomes: number;
    advantages: number;
    /** Ties, worse alternatives, and gaps at or below epsilon. */
    noAdvantage: number;
    /** The chosen arm has no observations in the evidence, so nothing is compared. */
    chosenUnobserved: number;
    /** Every other candidate is unobserved, so no alternative can be scored. */
    noObservedAlternative: number;
  };
  items: RegretItem[];
}

export class RegretEvidenceError extends Error {
  constructor(path: string, reason: string) {
    // Names the field path and rule only. Never echoes the offending value.
    super(`invalid regret evidence at ${path}: ${reason}`);
    this.name = 'RegretEvidenceError';
  }
}

/** Posterior expected value: success × quality, minus latency and token penalties. Same formula as the source. */
export function armExpectedValue(
  arm: Pick<RegretArmEvidence, 'alpha' | 'beta' | 'qualityMean' | 'latencyMean' | 'tokenMean' | 'observations' | 'tokenObservations'>,
  config: Pick<RegretScoringConfig, 'latencyWeight' | 'latencyReferenceMs' | 'tokenWeight' | 'tokenReference'>,
): number {
  const success = arm.alpha / (arm.alpha + arm.beta);
  const quality = arm.observations === 0 ? 1 : clamp01(arm.qualityMean);
  const latency = arm.observations === 0 ? 0 : Math.min(1, Math.max(0, arm.latencyMean) / config.latencyReferenceMs);
  const tokens = arm.tokenObservations === 0 ? 0 : Math.min(1, Math.max(0, arm.tokenMean) / config.tokenReference);
  return success * quality - config.latencyWeight * latency - config.tokenWeight * tokens;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Grok Ultra has two consumer arms; every other pool has one arm with a null consumer. */
export function regretConsumersFor(poolId: RegretPoolId): readonly (RegretConsumer | null)[] {
  return poolId === 'grok-ultra-weekly' ? REGRET_ULTRA_CONSUMERS : [null];
}

const armId = (jobType: RegretJobKind, poolId: RegretPoolId, consumer: RegretConsumer | null): string =>
  JSON.stringify([jobType, poolId, consumer]);

/**
 * Chosen-versus-best comparison over observed arms only. An unobserved arm is
 * unknown, not a prior value of 0.5, so it can never create an advantage.
 * Strictly greater wins, so exact ties keep the earliest candidate in pool order.
 */
export function computeRegret(evidence: RegretEvidence): RegretReport {
  const { epsilon } = evidence.config;
  const index = new Map(evidence.arms.map((arm) => [armId(arm.jobType, arm.poolId, arm.consumer), arm]));
  const items: RegretItem[] = [];
  const summary = { outcomes: 0, advantages: 0, noAdvantage: 0, chosenUnobserved: 0, noObservedAlternative: 0 };

  for (const outcome of evidence.outcomes) {
    summary.outcomes += 1;
    const chosenArm = index.get(armId(outcome.jobType, outcome.poolId, outcome.consumer));
    if (!chosenArm || chosenArm.observations === 0) {
      summary.chosenUnobserved += 1;
      continue;
    }
    const chosen = armExpectedValue(chosenArm, evidence.config);

    let best: { poolId: RegretPoolId; consumer: RegretConsumer | null; value: number } | null = null;
    for (const poolId of REGRET_POOL_IDS) {
      for (const consumer of regretConsumersFor(poolId)) {
        if (poolId === outcome.poolId && consumer === outcome.consumer) continue;
        const arm = index.get(armId(outcome.jobType, poolId, consumer));
        if (!arm || arm.observations === 0) continue;
        const value = armExpectedValue(arm, evidence.config);
        if (best === null || value > best.value) best = { poolId, consumer, value };
      }
    }
    if (best === null) {
      summary.noObservedAlternative += 1;
      continue;
    }
    if (best.value - chosen <= epsilon) {
      summary.noAdvantage += 1;
      continue;
    }
    summary.advantages += 1;
    items.push({
      jobId: outcome.jobId,
      jobType: outcome.jobType,
      chosenPool: outcome.poolId,
      chosenConsumer: outcome.consumer,
      betterPool: best.poolId,
      betterConsumer: best.consumer,
      chosenValue: chosen,
      betterValue: best.value,
      regret: best.value - chosen,
    });
  }

  return {
    schema: REGRET_REPORT_SCHEMA,
    source: REGRET_SOURCE,
    postIssues: false,
    notice: REGRET_NOTICE,
    epsilon,
    summary,
    items,
  };
}

/* ---------------------------------------------------------------- */
/*  Evidence validation. Every failure names a path, never a value. */
/* ---------------------------------------------------------------- */

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const MAX_ARMS_AND_OUTCOMES = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function finite(value: unknown, path: string, opts: { min?: number; positive?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RegretEvidenceError(path, 'must be a finite number');
  if (opts.positive && value <= 0) throw new RegretEvidenceError(path, 'must be greater than zero');
  if (opts.min !== undefined && value < opts.min) throw new RegretEvidenceError(path, `must be at least ${opts.min}`);
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RegretEvidenceError(path, 'must be a non-negative integer');
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RegretEvidenceError(path, 'is not a supported value');
  }
  return value as T;
}

/** Null is the only valid consumer for single-arm pools; Grok Ultra requires one of its two consumers. */
function consumerFor(poolId: RegretPoolId, value: unknown, path: string): RegretConsumer | null {
  if (value === undefined) throw new RegretEvidenceError(path, 'is required');
  if (poolId !== 'grok-ultra-weekly') {
    if (value !== null) throw new RegretEvidenceError(path, 'must be null for this pool');
    return null;
  }
  return oneOf(value, REGRET_ULTRA_CONSUMERS, path);
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new RegretEvidenceError(path, 'must be an array');
  if (value.length > MAX_ARMS_AND_OUTCOMES) throw new RegretEvidenceError(path, `must have at most ${MAX_ARMS_AND_OUTCOMES} entries`);
  return value;
}

/**
 * Validate untrusted JSON-shaped evidence and return typed input for computeRegret.
 * Missing `epsilon` takes the source default. Empty outcomes and arms are valid.
 */
export function parseRegretEvidence(raw: unknown): RegretEvidence {
  if (!isRecord(raw)) throw new RegretEvidenceError('$', 'must be an object');

  if (!isRecord(raw['config'])) throw new RegretEvidenceError('config', 'must be an object');
  const c = raw['config'];
  const epsilon = c['epsilon'] === undefined ? DEFAULT_REGRET_EPSILON : finite(c['epsilon'], 'config.epsilon', { min: 0 });
  const config = {
    latencyWeight: finite(c['latencyWeight'], 'config.latencyWeight', { min: 0 }),
    latencyReferenceMs: finite(c['latencyReferenceMs'], 'config.latencyReferenceMs', { positive: true }),
    tokenWeight: finite(c['tokenWeight'], 'config.tokenWeight', { min: 0 }),
    tokenReference: finite(c['tokenReference'], 'config.tokenReference', { positive: true }),
    epsilon,
  };

  const arms: RegretArmEvidence[] = [];
  const armKeys = new Set<string>();
  list(raw['arms'], 'arms').forEach((entry, i) => {
    const p = `arms[${i}]`;
    if (!isRecord(entry)) throw new RegretEvidenceError(p, 'must be an object');
    const jobType = oneOf(entry['jobType'], REGRET_JOB_KINDS, `${p}.jobType`);
    const poolId = oneOf(entry['poolId'], REGRET_POOL_IDS, `${p}.poolId`);
    const consumer = consumerFor(poolId, entry['consumer'], `${p}.consumer`);
    const key = armId(jobType, poolId, consumer);
    if (armKeys.has(key)) throw new RegretEvidenceError(p, 'duplicates an earlier arm identity');
    armKeys.add(key);
    arms.push({
      jobType,
      poolId,
      consumer,
      alpha: finite(entry['alpha'], `${p}.alpha`, { positive: true }),
      beta: finite(entry['beta'], `${p}.beta`, { positive: true }),
      qualityMean: finite(entry['qualityMean'], `${p}.qualityMean`),
      latencyMean: finite(entry['latencyMean'], `${p}.latencyMean`),
      tokenMean: finite(entry['tokenMean'], `${p}.tokenMean`),
      observations: count(entry['observations'], `${p}.observations`),
      tokenObservations: count(entry['tokenObservations'], `${p}.tokenObservations`),
    });
  });

  const outcomes: RegretOutcomeEvidence[] = list(raw['outcomes'], 'outcomes').map((entry, i) => {
    const p = `outcomes[${i}]`;
    if (!isRecord(entry)) throw new RegretEvidenceError(p, 'must be an object');
    const jobId = entry['jobId'];
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
      throw new RegretEvidenceError(`${p}.jobId`, 'must be 1-200 letters, digits or ._:/#- starting with a letter or digit');
    }
    const jobType = oneOf(entry['jobType'], REGRET_JOB_KINDS, `${p}.jobType`);
    const poolId = oneOf(entry['poolId'], REGRET_POOL_IDS, `${p}.poolId`);
    return { jobId, jobType, poolId, consumer: consumerFor(poolId, entry['consumer'], `${p}.consumer`) };
  });

  return { outcomes, arms, config };
}
