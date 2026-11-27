/**
 * Historical schedule-result assembly: one pure call that replays a recorded
 * solver run into its selections and decision rows by composing the recovered
 * projections. Describes a recorded run and grants nothing. Not live routing.
 *
 * Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/solve.ts schedule(), resultFrom()  -> assembleRecordedSchedule()
 *   scheduler/solve.ts chosenFromSolution()       -> projectRecordedSolution()
 *   scheduler/solve.ts greedyAssign()             -> caller-recorded fallbackSelections
 *   scheduler/solve.ts decisionsFrom()            -> projectRecordedDecisions()
 *
 * Preserved: optimal uses primal selections and the recorded ObjectiveValue;
 * infeasible has no assignments and never falls back; timeout and failed use the
 * recorded greedy selections with the matching reason.
 *
 * Intentional divergences: no solver call (the outcome is already-normalized
 * evidence); `objective` is only the recorded solver value or null, while
 * `assignmentTotal` is always the computed sum (the source's `objective ?? computed`
 * mixed them); timeout/failed without fallbackSelections throws rather than computing
 * greedy on the fly; fallback selections are validated for every status; runway,
 * monetary cost and the empty-model shortcut are omitted. 'optimal' is a recorded
 * status, not proof of current feasibility, quota or permission to dispatch.
 */

import {
  projectRecordedDecisions,
  type RecordedDecisionJob,
  type RecordedDecisionRow,
  type RecordedDecisionSolver,
} from './recorded-decision-projection.js';
import type { RecordedGreedyAssignment } from './recorded-greedy-assignment.js';
import type { NormalizedRecordedSolverResult } from './recorded-solver-result.js';
import { projectRecordedSolution, type SolutionVariableRow } from './solution-projection.js';
import {
  isFiniteNumber,
  isNonEmptyString as isNonEmpty,
  isRecord as isPlainObject,
} from './validation.js';

/** Pinned provenance. Describes a recording, never a live schedule. */
export const RECORDED_SCHEDULE_RESULT_PROVENANCE = Object.freeze({
  source: 'historical-offline',
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'recorded-schedule-result',
  grantsMergeAuthority: false,
} as const);

export type RecordedScheduleStatus = 'optimal' | 'infeasible' | 'fallback';
export type RecordedFallbackReason = 'timeout' | 'failed';

export interface RecordedScheduleJob {
  id: string;
  jobType: string;
  canary: boolean;
}

/** One recorded alternative: a solver variable plus the policy it was scored under. */
export interface RecordedScheduleVariableRow extends SolutionVariableRow {
  policyId: string;
}

export interface RecordedScheduleInput {
  jobs: readonly RecordedScheduleJob[];
  /** Names must match the primal column names of the recorded outcome. */
  variables: readonly RecordedScheduleVariableRow[];
  /** Normalized outcome (normalizeRecordedSolverResult output). */
  outcome: NormalizedRecordedSolverResult;
  /** Recorded greedy selections (e.g. recordedGreedyAssignment(...).assignments). Required for timeout/failed. */
  fallbackSelections?: readonly RecordedGreedyAssignment[];
  /** Policy recorded for unassigned jobs. Caller-supplied; no provider default. */
  defaultPolicyId: string;
  /** Recorded epoch milliseconds. No clock is read. */
  nowMs: number;
}

export interface RecordedScheduleResult {
  status: RecordedScheduleStatus;
  solver: RecordedDecisionSolver;
  fallbackReason: RecordedFallbackReason | null;
  /** Recorded solver ObjectiveValue for an optimal run (0 kept); null otherwise. */
  objective: number | null;
  /** Computed sum of selected coefficients, rounded to six decimals. */
  assignmentTotal: number;
  assignedJobIds: string[];
  unassignedJobIds: string[];
  /** One decision row per input job, in input order. */
  decisions: RecordedDecisionRow[];
  provenance: typeof RECORDED_SCHEDULE_RESULT_PROVENANCE;
  feasibilityAsserted: false;
  grantsMergeAuthority: false;
}

/** Thrown for malformed or inconsistent input. The message names the offending field. */
export class RecordedScheduleResultError extends Error {
  override name = 'RecordedScheduleResultError';
}

// Explicit function type so a call narrows the checked value after its guard.
const fail: (message: string) => never = (message) => {
  throw new RecordedScheduleResultError(message);
};

/**
 * Replay one recorded run into selections and decision rows. Pure and
 * non-mutating: inputs are read, never written, and every output is fresh.
 * Throws RecordedScheduleResultError, or the projection error it delegates to.
 */
export function assembleRecordedSchedule(input: RecordedScheduleInput): RecordedScheduleResult {
  if (!isPlainObject(input)) fail('input must be an object');
  if (!Array.isArray(input.jobs)) fail('jobs must be an array');
  if (!Array.isArray(input.variables)) fail('variables must be an array');
  const outcome: unknown = input.outcome;
  if (!isPlainObject(outcome)) fail('outcome must be an object');
  const status = outcome.status;
  if (status !== 'optimal' && status !== 'infeasible' && status !== 'timeout' && status !== 'failed') {
    fail("outcome.status must be 'optimal', 'infeasible', 'timeout' or 'failed'");
  }
  if (status === 'optimal' && !isFiniteNumber(outcome.objective)) fail('optimal outcome objective must be a finite number');
  if (status !== 'optimal' && outcome.objective !== null) fail(`${status} outcome objective must be null`);

  const jobIds = new Set<string>();
  input.jobs.forEach((job: unknown, index: number) => {
    if (!isPlainObject(job) || !isNonEmpty(job.id)) fail(`jobs[${index}].id must be a non-empty string`);
    jobIds.add(job.id as string);
  });
  // The recovered projection validates row names, coefficients and values for every status.
  const solution = projectRecordedSolution(input.variables, outcome.values as Record<string, number>);
  const rowsByJob = new Map<string, RecordedScheduleVariableRow[]>();
  input.variables.forEach((row: unknown, index: number) => {
    if (!isPlainObject(row)) fail(`variables[${index}] must be an object`);
    if (!isNonEmpty(row.jobId) || !jobIds.has(row.jobId)) fail(`variables[${index}] references an unknown job`);
    if (!isNonEmpty(row.policyId)) fail(`variables[${index}].policyId must be a non-empty string`);
    rowsByJob.set(row.jobId, [...(rowsByJob.get(row.jobId) ?? []), row as unknown as RecordedScheduleVariableRow]);
  });

  const fallback = checkFallback(input, rowsByJob);
  if ((status === 'timeout' || status === 'failed') && fallback === null) {
    fail(`${status} run requires recorded fallbackSelections; none were supplied`);
  }

  // Source control flow: infeasible never falls back; optimal uses primal selections; timeout/failed use greedy.
  const optimal = status === 'optimal';
  const fallbackReason: RecordedFallbackReason | null = status === 'timeout' || status === 'failed' ? status : null;
  const selected = new Map<string, { poolId: string; consumer: string | null }>();
  if (optimal) for (const s of solution.selections) selected.set(s.jobId, { poolId: s.poolId, consumer: s.consumer });
  if (fallbackReason !== null) for (const [jobId, pick] of fallback ?? []) selected.set(jobId, pick);
  const solver: RecordedDecisionSolver = fallbackReason !== null ? 'greedy' : 'highs';

  const decisionJobs: RecordedDecisionJob[] = input.jobs.map((job) => ({
    id: job.id,
    jobType: job.jobType,
    canary: job.canary,
    eligible: (rowsByJob.get(job.id) ?? []).map((r) => ({
      poolId: r.poolId,
      consumer: r.consumer,
      policyId: r.policyId,
      coefficient: r.coefficient,
    })),
    selected: selected.get(job.id) ?? null,
  }));
  const decided = projectRecordedDecisions({
    jobs: decisionJobs,
    defaultPolicyId: input.defaultPolicyId,
    nowMs: input.nowMs,
    solver,
    fallback: fallbackReason !== null,
  });

  return {
    status: fallbackReason !== null ? 'fallback' : status === 'optimal' ? 'optimal' : 'infeasible',
    solver,
    fallbackReason,
    objective: optimal ? outcome.objective as number : null,
    assignmentTotal: decided.objective,
    assignedJobIds: decided.assignedJobIds,
    unassignedJobIds: decided.unassignedJobIds,
    decisions: decided.decisions,
    provenance: { ...RECORDED_SCHEDULE_RESULT_PROVENANCE },
    feasibilityAsserted: false,
    grantsMergeAuthority: false,
  };
}

/**
 * Validate supplied fallback evidence for every status. Returns null only when
 * none was supplied. Malformed evidence throws even when the status ignores it.
 */
function checkFallback(
  input: RecordedScheduleInput,
  rowsByJob: ReadonlyMap<string, readonly RecordedScheduleVariableRow[]>,
): Map<string, { poolId: string; consumer: string | null }> | null {
  if (input.fallbackSelections === undefined) return null;
  if (!Array.isArray(input.fallbackSelections)) fail('fallbackSelections must be an array');
  const selected = new Map<string, { poolId: string; consumer: string | null }>();
  input.fallbackSelections.forEach((raw: unknown, index: number) => {
    const where = `fallbackSelections[${index}]`;
    if (!isPlainObject(raw) || !isNonEmpty(raw.jobId)) fail(`${where}.jobId must be a non-empty string`);
    const jobIndex = raw.jobIndex;
    if (typeof jobIndex !== 'number' || !Number.isSafeInteger(jobIndex) || jobIndex < 0 || jobIndex >= input.jobs.length) {
      fail(`${where}.jobIndex must index a recorded job`);
    }
    if (input.jobs[jobIndex as number]?.id !== raw.jobId) fail(`${where}.jobIndex does not match jobId ${String(raw.jobId)}`);
    if (selected.has(raw.jobId)) fail(`${where} selects job ${raw.jobId} more than once`);
    if (!isNonEmpty(raw.poolId)) fail(`${where}.poolId must be a non-empty string`);
    if (raw.consumer !== null && !isNonEmpty(raw.consumer)) fail(`${where}.consumer must be a non-empty string or null`);
    if (!isFiniteNumber(raw.coefficient)) fail(`${where}.coefficient must be a finite number`);
    if (!isFiniteNumber(raw.demand) || raw.demand < 0) fail(`${where}.demand must be a finite non-negative number`);
    if (raw.quota !== 'known' && raw.quota !== 'unknown') fail(`${where}.quota must be 'known' or 'unknown'`);

    const offered = (rowsByJob.get(raw.jobId) ?? []).find((r) => r.poolId === raw.poolId && r.consumer === raw.consumer);
    if (!offered) fail(`${where} names an alternative that was not offered for job ${raw.jobId}`);
    if (offered.coefficient !== raw.coefficient) fail(`${where} coefficient does not match the offered alternative`);
    selected.set(raw.jobId, { poolId: raw.poolId, consumer: raw.consumer as string | null });
  });
  return selected;
}
