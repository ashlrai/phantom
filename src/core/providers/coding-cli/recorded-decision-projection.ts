/**
 * Historical projection of recorded router decision rows, one per job, including
 * unassigned jobs and the eligible alternatives each job was offered. Pure;
 * describes a recorded run and grants nothing. Not live routing.
 *
 * Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/solve.ts  decisionsFrom()  -> projectRecordedDecisions() loop
 *   scheduler/solve.ts  decision()       -> RecordedDecisionRow shape and field values
 *   scheduler/solve.ts  round6()         -> objective rounding (six decimals)
 *   scheduler/types.ts  RouterDecision   -> RecordedDecisionRow (grantsMergeAuthority: false)
 *
 * Preserved: unassigned rows carry null pool, consumer and netValue; the policy
 * defaults when nothing was selected; a selected alternative's policy wins over
 * the default; propensity is 1; the eligible list is kept in recorded order;
 * the objective is the sum of selected coefficients in job order, rounded to six
 * decimals.
 *
 * Divergences (intentional validation adaptations, not semantic changes):
 *  - Inputs are validated and throw RecordedDecisionProjectionError. The source
 *    trusts its own solver output.
 *  - Duplicate job IDs, duplicate (poolId, consumer) alternatives within one job,
 *    and a selection that names no eligible alternative are rejected. The source
 *    would silently pick the first match, or fall back to the default policy.
 *  - Identities are caller-supplied strings. No pool or consumer enum and no
 *    provider default is applied (decision-reader.ts hard-codes one).
 *  - Eligibility is never recomputed and quota is never inferred; the caller
 *    records the alternatives as they were offered.
 *  - Canary is recorded per job. The source derives it from pairs or a hash.
 *  - Output objects are fresh; inputs are never mutated.
 */

import {
  isFiniteNumber,
  isNonEmptyString as isNonEmpty,
  isRecord as isPlainObject,
  round6,
} from './validation.js';

/** Pinned provenance. Every projection carries it; it describes a recording, never a live decision. */
export const RECORDED_DECISION_PROVENANCE = Object.freeze({
  source: 'historical-offline',
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'recorded-decision-rows',
} as const);

/** The solver recorded for the run. Mirrors the source union. */
export type RecordedDecisionSolver = 'highs' | 'greedy';

/** One alternative a job was recorded as eligible for. */
export interface RecordedDecisionAlternative {
  poolId: string;
  /** Consumer identity, or null for a pool without consumers. */
  consumer: string | null;
  /** Policy under which this alternative was scored. */
  policyId: string;
  /** Recorded coefficient. Finite; negative values are legitimate. */
  coefficient: number;
}

/** One recorded job. Input order is output order. */
export interface RecordedDecisionJob {
  id: string;
  jobType: string;
  /** Recorded canary flag for this job. */
  canary: boolean;
  /** Eligible alternatives in recorded order. May be empty. */
  eligible: readonly RecordedDecisionAlternative[];
  /** The recorded selection. Null or absent means the job was unassigned. */
  selected?: { poolId: string; consumer: string | null } | null;
}

export interface RecordedDecisionProjectionInput {
  jobs: readonly RecordedDecisionJob[];
  /** Policy used when no alternative was selected. */
  defaultPolicyId: string;
  /** Recorded timestamp, in epoch milliseconds. Integer and within the Date range. */
  nowMs: number;
  solver: RecordedDecisionSolver;
  fallback: boolean;
}

/** An eligible alternative as the source records it (no policy, no coefficient). */
export interface RecordedDecisionEligibleRef {
  poolId: string;
  consumer: string | null;
}

/** One historical decision row. Mirrors RouterDecision with caller-supplied identities. */
export interface RecordedDecisionRow {
  ts: string;
  jobId: string;
  jobType: string;
  poolId: string | null;
  consumer: string | null;
  policyId: string;
  canary: boolean;
  /** Always 1. Deterministic-source metadata, not a measured exploration probability. */
  propensity: 1;
  solver: RecordedDecisionSolver;
  fallback: boolean;
  /** Always false. The recorded scheduler never grants merge authority. */
  grantsMergeAuthority: false;
  netValue: number | null;
  eligible: RecordedDecisionEligibleRef[];
}

export interface RecordedDecisionProjection {
  /** One row per input job, in input order. */
  decisions: RecordedDecisionRow[];
  assignedJobIds: string[];
  unassignedJobIds: string[];
  /** Sum of selected coefficients, rounded to six decimals. */
  objective: number;
  provenance: typeof RECORDED_DECISION_PROVENANCE;
  grantsMergeAuthority: false;
}

/** Thrown for malformed input. The message names the offending field. */
export class RecordedDecisionProjectionError extends Error {
  override name = 'RecordedDecisionProjectionError';
}

const MAX_DATE_MS = 8.64e15;
const SOLVERS: readonly string[] = ['highs', 'greedy'];
const keyOf = (poolId: string, consumer: string | null): string => JSON.stringify([poolId, consumer]);

function checkAlternative(alt: unknown, where: string): RecordedDecisionAlternative {
  if (!isPlainObject(alt)) throw new RecordedDecisionProjectionError(`${where} must be an object`);
  if (!isNonEmpty(alt['poolId'])) throw new RecordedDecisionProjectionError(`${where}.poolId must be a non-empty string`);
  if (alt['consumer'] !== null && !isNonEmpty(alt['consumer'])) {
    throw new RecordedDecisionProjectionError(`${where}.consumer must be a non-empty string or null`);
  }
  if (!isNonEmpty(alt['policyId'])) throw new RecordedDecisionProjectionError(`${where}.policyId must be a non-empty string`);
  if (!isFiniteNumber(alt['coefficient'])) throw new RecordedDecisionProjectionError(`${where}.coefficient must be a finite number`);
  return {
    poolId: alt['poolId'],
    consumer: alt['consumer'] as string | null,
    policyId: alt['policyId'],
    coefficient: alt['coefficient'],
  };
}

/**
 * Project recorded decision rows. Pure and non-mutating; returns fresh objects.
 * Throws RecordedDecisionProjectionError on malformed or inconsistent input.
 * Never recomputes eligibility, infers quota, reads a clock or executes a solver.
 */
export function projectRecordedDecisions(input: RecordedDecisionProjectionInput): RecordedDecisionProjection {
  if (!isPlainObject(input)) throw new RecordedDecisionProjectionError('input must be an object');
  if (!Array.isArray(input.jobs)) throw new RecordedDecisionProjectionError('jobs must be an array');
  if (!isNonEmpty(input.defaultPolicyId)) {
    throw new RecordedDecisionProjectionError('defaultPolicyId must be a non-empty string');
  }
  if (!Number.isSafeInteger(input.nowMs) || Math.abs(input.nowMs) > MAX_DATE_MS) {
    throw new RecordedDecisionProjectionError('nowMs must be an integer epoch-millisecond value within the Date range');
  }
  if (!SOLVERS.includes(input.solver)) throw new RecordedDecisionProjectionError("solver must be 'highs' or 'greedy'");
  if (typeof input.fallback !== 'boolean') throw new RecordedDecisionProjectionError('fallback must be a boolean');

  const ts = new Date(input.nowMs).toISOString();
  const seenJobs = new Set<string>();
  const decisions: RecordedDecisionRow[] = [];
  const assignedJobIds: string[] = [];
  const unassignedJobIds: string[] = [];
  let objective = 0;

  input.jobs.forEach((job: unknown, index: number) => {
    const where = `jobs[${index}]`;
    if (!isPlainObject(job)) throw new RecordedDecisionProjectionError(`${where} must be an object`);
    if (!isNonEmpty(job['id'])) throw new RecordedDecisionProjectionError(`${where}.id must be a non-empty string`);
    if (!isNonEmpty(job['jobType'])) throw new RecordedDecisionProjectionError(`${where}.jobType must be a non-empty string`);
    if (typeof job['canary'] !== 'boolean') throw new RecordedDecisionProjectionError(`${where}.canary must be a boolean`);
    if (seenJobs.has(job['id'])) throw new RecordedDecisionProjectionError(`duplicate job id ${JSON.stringify(job['id'])}`);
    seenJobs.add(job['id']);
    if (!Array.isArray(job['eligible'])) throw new RecordedDecisionProjectionError(`${where}.eligible must be an array`);

    const eligible = (job['eligible'] as unknown[]).map((alt, i) => checkAlternative(alt, `${where}.eligible[${i}]`));
    const byKey = new Map<string, RecordedDecisionAlternative>();
    for (const alt of eligible) {
      const key = keyOf(alt.poolId, alt.consumer);
      if (byKey.has(key)) {
        throw new RecordedDecisionProjectionError(`${where} lists alternative ${key} more than once`);
      }
      byKey.set(key, alt);
    }

    const selected = job['selected'];
    let chosen: RecordedDecisionAlternative | null = null;
    if (selected !== undefined && selected !== null) {
      if (!isPlainObject(selected) || !isNonEmpty(selected['poolId'])) {
        throw new RecordedDecisionProjectionError(`${where}.selected.poolId must be a non-empty string`);
      }
      if (selected['consumer'] !== null && !isNonEmpty(selected['consumer'])) {
        throw new RecordedDecisionProjectionError(`${where}.selected.consumer must be a non-empty string or null`);
      }
      const key = keyOf(selected['poolId'], selected['consumer'] as string | null);
      chosen = byKey.get(key) ?? null;
      // Source falls back to the default policy here. Recorded data should never
      // name an alternative that was not offered, so this is rejected instead.
      if (!chosen) throw new RecordedDecisionProjectionError(`${where}.selected ${key} is not an eligible alternative`);
    }

    const eligibleRefs: RecordedDecisionEligibleRef[] = eligible.map((alt) => ({ poolId: alt.poolId, consumer: alt.consumer }));
    if (!chosen) {
      unassignedJobIds.push(job['id']);
      decisions.push({
        ts,
        jobId: job['id'],
        jobType: job['jobType'],
        poolId: null,
        consumer: null,
        policyId: input.defaultPolicyId,
        canary: job['canary'],
        propensity: 1,
        solver: input.solver,
        fallback: input.fallback,
        grantsMergeAuthority: false,
        netValue: null,
        eligible: eligibleRefs,
      });
      return;
    }

    objective += chosen.coefficient;
    assignedJobIds.push(job['id']);
    decisions.push({
      ts,
      jobId: job['id'],
      jobType: job['jobType'],
      poolId: chosen.poolId,
      consumer: chosen.consumer,
      policyId: chosen.policyId,
      canary: job['canary'],
      propensity: 1,
      solver: input.solver,
      fallback: input.fallback,
      grantsMergeAuthority: false,
      netValue: chosen.coefficient,
      eligible: eligibleRefs,
    });
  });

  return {
    decisions,
    assignedJobIds,
    unassignedJobIds,
    objective: round6(objective),
    provenance: RECORDED_DECISION_PROVENANCE,
    grantsMergeAuthority: false,
  };
}
