/**
 * Interpretation of a recorded HiGHS solver result as an outcome class with
 * optional primal values. Pure; describes a historical record and grants nothing.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/solve.ts highsSolver()  Status === 'Infeasible'             -> 'infeasible'
 *   scheduler/solve.ts highsSolver()  Status === 'Time limit reached'
 *                                     || elapsed > budget                 -> 'timeout'
 *   scheduler/solve.ts highsSolver()  Status not 'Optimal' and not 'Empty' -> 'failed'
 *   scheduler/solve.ts highsSolver()  Columns own entries, numeric Primal  -> values
 *   scheduler/solve.ts highsSolver()  ObjectiveValue                       -> objective
 *   scheduler/solve.ts highsSolver()  catch {}                             -> 'failed' (see divergences)
 *
 * Precedence is the source's: infeasible is tested first, so an infeasible
 * record that also exceeded its budget is still infeasible. An unknown status
 * that also exceeded its budget is a timeout, because the source checks the
 * budget before the status allow-list.
 *
 * Divergences from the source:
 *   - Timing is validated on every call, including infeasible results. The source
 *     never validated it. A non-finite or negative elapsed value never becomes optimal.
 *   - Malformed evidence throws RecordedSolverResultError with a stable `reason`.
 *     The source's catch-all returned 'failed', which hid the difference between
 *     a broken record and a solver failure. A genuine recorded infeasible result
 *     still returns normally.
 *   - Optimal and Empty results must carry a finite ObjectiveValue. The source
 *     passed through whatever it got. This module never fabricates an objective of 0.
 *   - A present Primal must be a finite number. An absent Primal is skipped, as in the
 *     source. Non-numeric or non-finite values throw rather than being dropped.
 *   - Only own enumerable Columns entries are read, and each Primal must be an own
 *     property (the source read inherited ones too). Values are built with
 *     Object.fromEntries so an entry named "__proto__" stays a plain data key.
 *   - Output is fresh and inputs are never mutated.
 *
 * Limits: 'optimal' is a recorded solver status. It is not proof that the
 * current model is feasible, not current quota, and not permission to dispatch.
 */

import { isFiniteNumber, isRecord } from './validation.js';

/** Provenance attached to every normalized result. Recorded, never current. */
export const RECORDED_SOLVER_RESULT_PROVENANCE = Object.freeze({
  source: 'historical-offline',
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'recorded-solver-result',
  grantsMergeAuthority: false,
} as const);

/** The HiGHS result fields the interpretation reads. Runtime-validated before use. */
export interface RecordedSolverResult {
  Status: string;
  ObjectiveValue?: number;
  Columns?: Readonly<Record<string, unknown>>;
}

/** Timing recorded with the result. Passed explicitly; this module reads no clock. */
export interface RecordedSolverTiming {
  elapsedMs: number;
  budgetMs: number;
}

export type RecordedSolverStatus = 'optimal' | 'infeasible' | 'timeout' | 'failed';

/** Stable reasons for malformed evidence. Each one names the rejected field. */
export type RecordedSolverMalformedReason =
  | 'result-not-object'
  | 'status-not-string'
  | 'timing-not-object'
  | 'elapsed-ms-invalid'
  | 'budget-ms-invalid'
  | 'objective-invalid'
  | 'columns-invalid'
  | 'column-invalid'
  | 'primal-invalid';

/** Thrown for malformed evidence. Never returned as a status. */
export class RecordedSolverResultError extends Error {
  override name = 'RecordedSolverResultError';
  readonly reason: RecordedSolverMalformedReason;

  constructor(reason: RecordedSolverMalformedReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface NormalizedRecordedSolverResult {
  status: RecordedSolverStatus;
  /** Recorded ObjectiveValue for 'optimal'; null for every other status. */
  objective: number | null;
  /** Recorded Primal values for 'optimal'; empty for every other status. */
  values: Record<string, number>;
  provenance: typeof RECORDED_SOLVER_RESULT_PROVENANCE;
  feasibilityAsserted: false;
  grantsMergeAuthority: false;
}

function outcome(
  status: RecordedSolverStatus,
  objective: number | null,
  values: Record<string, number>,
): NormalizedRecordedSolverResult {
  return {
    status,
    objective,
    values,
    provenance: { ...RECORDED_SOLVER_RESULT_PROVENANCE },
    feasibilityAsserted: false,
    grantsMergeAuthority: false,
  };
}

/**
 * Interpret a recorded solver result. Pure and non-mutating. Throws
 * RecordedSolverResultError for malformed evidence, and returns a status for
 * every well-formed record, including a recorded infeasible result.
 */
export function normalizeRecordedSolverResult(
  recorded: RecordedSolverResult,
  timing: RecordedSolverTiming,
): NormalizedRecordedSolverResult {
  const rec: unknown = recorded;
  if (!isRecord(rec)) {
    throw new RecordedSolverResultError('result-not-object', 'recorded result must be an object');
  }
  if (typeof rec.Status !== 'string') {
    throw new RecordedSolverResultError('status-not-string', 'recorded Status must be a string');
  }
  const t: unknown = timing;
  if (!isRecord(t)) {
    throw new RecordedSolverResultError('timing-not-object', 'timing must be an object');
  }
  if (!isFiniteNumber(t.elapsedMs) || t.elapsedMs < 0) {
    throw new RecordedSolverResultError('elapsed-ms-invalid', 'elapsedMs must be a finite number >= 0');
  }
  if (!isFiniteNumber(t.budgetMs) || t.budgetMs <= 0) {
    throw new RecordedSolverResultError('budget-ms-invalid', 'budgetMs must be a finite number > 0');
  }

  const status = rec.Status;
  if (status === 'Infeasible') return outcome('infeasible', null, {});
  if (status === 'Time limit reached' || t.elapsedMs > t.budgetMs) return outcome('timeout', null, {});
  if (status !== 'Optimal' && status !== 'Empty') return outcome('failed', null, {});

  const objective = rec.ObjectiveValue;
  if (!isFiniteNumber(objective)) {
    throw new RecordedSolverResultError('objective-invalid', 'ObjectiveValue must be a finite number for an optimal record');
  }
  const columns = rec.Columns;
  if (!isRecord(columns)) {
    throw new RecordedSolverResultError('columns-invalid', 'Columns must be an object for an optimal record');
  }
  const entries: [string, number][] = [];
  for (const [name, column] of Object.entries(columns)) {
    if (!isRecord(column)) {
      throw new RecordedSolverResultError('column-invalid', `Columns[${JSON.stringify(name)}] must be an object`);
    }
    // Own property only: an inherited Primal is not recorded evidence.
    const primal = Object.prototype.hasOwnProperty.call(column, 'Primal') ? column.Primal : undefined;
    if (primal === undefined) continue;
    if (!isFiniteNumber(primal)) {
      throw new RecordedSolverResultError('primal-invalid', `Columns[${JSON.stringify(name)}].Primal must be a finite number`);
    }
    entries.push([name, primal]);
  }
  return outcome('optimal', objective, Object.fromEntries(entries));
}
