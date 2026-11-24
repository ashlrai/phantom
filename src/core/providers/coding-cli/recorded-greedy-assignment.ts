/**
 * Historical greedy assignment replay over prequalified recorded candidates.
 * Pure: caller-supplied recorded values only. Recovered from PR #5952
 * (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886), scheduler/solve.ts
 * greedyAssign(). It explains why recorded capacity admitted or deferred each
 * job; it never executes, dispatches, probes quota, or authorizes spend.
 *
 * Preserved source semantics:
 * - Ranked pools are scanned in order; within a pool, pairs are taken in
 *   recorded order (first fit, not coefficient ranking).
 * - Each job is assigned at most once.
 * - Concurrency: admitted-in-run plus in-flight must stay below the pool limit.
 * - Known quota: cumulative admitted demand must stay within room + 1e-9.
 * - Shared limits: cumulative matching demand must stay within limit + 1e-9.
 *
 * Deliberate offline adaptations (the source had none of these):
 * - The source's hard-coded 'grok-ultra-weekly' pool and 'cloud-agent'
 *   consumer caps become caller-recorded constraints selected by poolId and/or
 *   consumer. This module carries no Grok-specific runtime policy.
 * - Ranking is an input (`rankedPoolIds`), not derived from a spend-pool
 *   ranker with clock and default policy.
 * - Unknown quota is `{ known: false }`: it is never zero and never inferred
 *   room. It imposes no bound, and the assignment records quota: 'unknown'.
 * - Nonpositive coefficients throw. The source silently filtered them, but
 *   this input is a prequalified set, so a zero or negative value is a caller
 *   error.
 * - Malformed, non-finite, negative, duplicate or unknown-reference inputs
 *   throw. The source had no validation.
 * - Every rejected candidate is reported in `deferrals` with its first binding
 *   reason, so a replay shows why capacity deferred a job.
 */

export const RECORDED_GREEDY_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'historical-offline',
} as const;

/** Source tolerance for quota and shared-limit comparisons. */
export const RECORDED_GREEDY_TOLERANCE = 1e-9;

export type RecordedQuota = { known: true; room: number } | { known: false };

export interface RecordedGreedyPool {
  id: string;
  /** Maximum admissions in flight at once for this pool (a count). */
  concurrency: number;
  /** Already-running count recorded at decision time (a count). */
  inFlight: number;
  quota: RecordedQuota;
}

export interface RecordedGreedyPair {
  poolId: string;
  /** Consumer label, or null when the candidate has no consumer. */
  consumer: string | null;
  /** Strictly positive, prequalified coefficient. */
  coefficient: number;
  /** Non-negative demand charged against quota and shared limits. */
  demand: number;
}

export interface RecordedGreedyJob {
  id: string;
  /** Prequalified candidates in recorded order. */
  pairs: readonly RecordedGreedyPair[];
}

/**
 * Caller-recorded cap on cumulative demand of admitted pairs. A pair matches
 * when every selector that is set equals the pair's value. At least one of
 * poolId or consumer must be set.
 */
export interface RecordedSharedConstraint {
  id: string;
  poolId?: string;
  consumer?: string;
  limit: number;
}

export interface RecordedGreedyInput {
  rankedPoolIds: readonly string[];
  pools: readonly RecordedGreedyPool[];
  jobs: readonly RecordedGreedyJob[];
  sharedConstraints?: readonly RecordedSharedConstraint[];
}

export type RecordedGreedyDeferralReason = 'concurrency' | 'quota' | 'shared-constraint';

export interface RecordedGreedyAssignment {
  jobId: string;
  jobIndex: number;
  poolId: string;
  consumer: string | null;
  coefficient: number;
  demand: number;
  quota: 'known' | 'unknown';
}

export interface RecordedGreedyDeferral {
  jobId: string;
  poolId: string;
  consumer: string | null;
  reason: RecordedGreedyDeferralReason;
  /** Id of the binding shared constraint, or null for other reasons. */
  constraintId: string | null;
}

export interface RecordedGreedyPoolUsage {
  poolId: string;
  admitted: number;
  demand: number;
}

export interface RecordedGreedyResult {
  provenance: typeof RECORDED_GREEDY_PROVENANCE;
  /** Admitted assignments in job order. */
  assignments: RecordedGreedyAssignment[];
  unassignedJobIds: string[];
  /** Every rejected candidate in evaluation order, with its first binding reason. */
  deferrals: RecordedGreedyDeferral[];
  /** Per-pool totals from this run, in ranked pool order. */
  poolUsage: RecordedGreedyPoolUsage[];
}

const fail = (message: string): never => {
  throw new Error(`recordedGreedyAssignment: ${message}`);
};

const requireId = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value as string;
};

const requireFinite = (value: unknown, label: string): number => {
  if (typeof value !== 'number') fail(`${label} must be a number`);
  if (!Number.isFinite(value)) fail(`${label} must be finite`);
  return value as number;
};

const requireNonNegative = (value: unknown, label: string): number => {
  const n = requireFinite(value, label);
  if (n < 0) fail(`${label} must be non-negative`);
  return n;
};

const requireCount = (value: unknown, label: string): number => {
  const n = requireFinite(value, label);
  if (!Number.isSafeInteger(n) || n < 0) fail(`${label} must be a non-negative integer`);
  return n;
};

interface Validated {
  pools: Map<string, RecordedGreedyPool>;
  ranked: string[];
  constraints: RecordedSharedConstraint[];
}

function validate(input: RecordedGreedyInput): Validated {
  if (typeof input !== 'object' || input === null) fail('input must be an object');
  if (!Array.isArray(input.pools)) fail('pools must be an array');
  if (!Array.isArray(input.rankedPoolIds)) fail('rankedPoolIds must be an array');
  if (!Array.isArray(input.jobs)) fail('jobs must be an array');

  const pools = new Map<string, RecordedGreedyPool>();
  for (const pool of input.pools) {
    const id = requireId(pool.id, 'pool.id');
    if (pools.has(id)) fail(`duplicate pool id ${id}`);
    requireCount(pool.concurrency, `pool ${id} concurrency`);
    requireCount(pool.inFlight, `pool ${id} inFlight`);
    if (typeof pool.quota !== 'object' || pool.quota === null) fail(`pool ${id} quota must be explicit`);
    if (pool.quota.known === true) requireNonNegative(pool.quota.room, `pool ${id} quota room`);
    else if (pool.quota.known !== false) fail(`pool ${id} quota.known must be a boolean`);
    pools.set(id, pool);
  }

  const ranked: string[] = [];
  const seenRanked = new Set<string>();
  for (const raw of input.rankedPoolIds) {
    const id = requireId(raw, 'rankedPoolIds entry');
    if (seenRanked.has(id)) fail(`duplicate ranked pool id ${id}`);
    if (!pools.has(id)) fail(`ranked pool id ${id} has no pool state`);
    seenRanked.add(id);
    ranked.push(id);
  }
  if (ranked.length !== pools.size) fail('rankedPoolIds must rank every pool exactly once');

  const jobIds = new Set<string>();
  for (const job of input.jobs) {
    const jobId = requireId(job.id, 'job.id');
    if (jobIds.has(jobId)) fail(`duplicate job id ${jobId}`);
    jobIds.add(jobId);
    if (!Array.isArray(job.pairs)) fail(`job ${jobId} pairs must be an array`);
    const pairKeys = new Set<string>();
    for (const pair of job.pairs) {
      const poolId = requireId(pair.poolId, `job ${jobId} pair poolId`);
      if (!pools.has(poolId)) fail(`job ${jobId} references unknown pool ${poolId}`);
      if (pair.consumer !== null && typeof pair.consumer !== 'string') fail(`job ${jobId} pair consumer must be a string or null`);
      if (typeof pair.consumer === 'string') requireId(pair.consumer, `job ${jobId} pair consumer`);
      const coefficient = requireFinite(pair.coefficient, `job ${jobId} pair ${poolId} coefficient`);
      if (coefficient <= 0) fail(`job ${jobId} pair ${poolId} coefficient must be positive`);
      requireNonNegative(pair.demand, `job ${jobId} pair ${poolId} demand`);
      const key = `${poolId}\u0000${pair.consumer ?? ''}`;
      if (pairKeys.has(key)) fail(`job ${jobId} has duplicate pair ${poolId}/${pair.consumer ?? 'none'}`);
      pairKeys.add(key);
    }
  }

  const constraintIds = new Set<string>();
  const constraints: RecordedSharedConstraint[] = [];
  for (const c of input.sharedConstraints ?? []) {
    const id = requireId(c.id, 'shared constraint id');
    if (constraintIds.has(id)) fail(`duplicate shared constraint id ${id}`);
    constraintIds.add(id);
    if (c.poolId === undefined && c.consumer === undefined) fail(`shared constraint ${id} needs poolId or consumer`);
    if (c.poolId !== undefined && !pools.has(requireId(c.poolId, `shared constraint ${id} poolId`))) {
      fail(`shared constraint ${id} references unknown pool ${c.poolId}`);
    }
    if (c.consumer !== undefined) requireId(c.consumer, `shared constraint ${id} consumer`);
    requireNonNegative(c.limit, `shared constraint ${id} limit`);
    constraints.push(c);
  }

  return { pools, ranked, constraints };
}

/**
 * Replays recorded greedy admission over prequalified candidates. Jobs are
 * processed in the given order. For each job, candidates are scanned by ranked
 * pool, then by recorded pair order, and the first admissible one is taken.
 * Pure: no clock, I/O, network or solver.
 */
export function recordedGreedyAssignment(input: RecordedGreedyInput): RecordedGreedyResult {
  const { pools, ranked, constraints } = validate(input);
  const admittedByPool = new Map<string, number>();
  const demandByPool = new Map<string, number>();
  const demandByConstraint = new Map<string, number>(constraints.map((c) => [c.id, 0]));
  const assignments: RecordedGreedyAssignment[] = [];
  const deferrals: RecordedGreedyDeferral[] = [];
  const unassignedJobIds: string[] = [];

  input.jobs.forEach((job, jobIndex) => {
    let admitted = false;
    const candidates = ranked.flatMap((poolId) => job.pairs.filter((pair) => pair.poolId === poolId));
    for (const pair of candidates) {
      const pool = pools.get(pair.poolId) as RecordedGreedyPool;
      const defer = (reason: RecordedGreedyDeferralReason, constraintId: string | null): void => {
        deferrals.push({ jobId: job.id, poolId: pair.poolId, consumer: pair.consumer, reason, constraintId });
      };

      const inRun = admittedByPool.get(pool.id) ?? 0;
      if (inRun + pool.inFlight + 1 > pool.concurrency) {
        defer('concurrency', null);
        continue;
      }
      const used = demandByPool.get(pool.id) ?? 0;
      if (pool.quota.known && used + pair.demand > pool.quota.room + RECORDED_GREEDY_TOLERANCE) {
        defer('quota', null);
        continue;
      }
      const matching = constraints.filter(
        (c) => (c.poolId === undefined || c.poolId === pair.poolId) && (c.consumer === undefined || c.consumer === pair.consumer),
      );
      const binding = matching.find(
        (c) => (demandByConstraint.get(c.id) ?? 0) + pair.demand > c.limit + RECORDED_GREEDY_TOLERANCE,
      );
      if (binding) {
        defer('shared-constraint', binding.id);
        continue;
      }

      admittedByPool.set(pool.id, inRun + 1);
      demandByPool.set(pool.id, used + pair.demand);
      for (const c of matching) demandByConstraint.set(c.id, (demandByConstraint.get(c.id) ?? 0) + pair.demand);
      assignments.push({
        jobId: job.id,
        jobIndex,
        poolId: pair.poolId,
        consumer: pair.consumer,
        coefficient: pair.coefficient,
        demand: pair.demand,
        quota: pool.quota.known ? 'known' : 'unknown',
      });
      admitted = true;
      break;
    }
    if (!admitted) unassignedJobIds.push(job.id);
  });

  const poolUsage = ranked.map((poolId) => ({
    poolId,
    admitted: admittedByPool.get(poolId) ?? 0,
    demand: demandByPool.get(poolId) ?? 0,
  }));

  return { provenance: RECORDED_GREEDY_PROVENANCE, assignments, unassignedJobIds, deferrals, poolUsage };
}
