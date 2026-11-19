/**
 * Diagnostic projection of a recorded solver result onto the assignment it
 * selected. Pure; describes a historical record and grants nothing.
 *
 * Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/solve.ts  chosenFromSolution()       -> projectRecordedSolution() selection loop
 *   scheduler/solve.ts  Variable                   -> SolutionVariableRow (jobIndex becomes jobId)
 *   scheduler/solve.ts  decisionsFrom() assignment -> SolutionSelection (netValue, monetaryCost omitted)
 *   scheduler/types.ts  SolverOutcome.values       -> RecordedPrimalValues
 *   scheduler/types.ts  Assignment.grantsMergeAuthority -> grantsMergeAuthority: false
 *
 * Preserved: absent primal = 0; primal < 0.5 not selected; per job the largest
 * coefficient wins, an equal coefficient keeps the first (strict `>`); jobs are
 * ordered by first selection (Map insertion order); unknown names are ignored.
 *
 * Divergences: inputs are validated (SolutionProjectionError); primal lookup is
 * own-property only; output is fresh and inputs are never mutated; no
 * feasibility is asserted for fractional primals.
 */

/** The source's selection threshold on a primal value. */
export const SOLUTION_SELECTION_THRESHOLD = 0.5;

/** Provenance attached to every projection. Recorded, never current. */
export const SOLUTION_PROJECTION_PROVENANCE = Object.freeze({
  source: 'historical-offline',
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'recorded-primal-values',
} as const);

/** One recorded variable. Identities are caller-supplied. */
export interface SolutionVariableRow {
  /** Unique within one call. */
  name: string;
  jobId: string;
  poolId: string;
  /** Consumer identity, or null for a pool without consumers. */
  consumer: string | null;
  /** Finite; negative values are legitimate. */
  coefficient: number;
}

/** Recorded primal values keyed by variable name. Every value must be finite. */
export type RecordedPrimalValues = Readonly<Record<string, number>>;

/** The variable a job's recorded solution selected. */
export interface SolutionSelection {
  jobId: string;
  poolId: string;
  consumer: string | null;
  variableName: string;
  coefficient: number;
}

/** Diagnostic only. Not a schedule, admission or dispatch decision. */
export interface SolutionProjection {
  /** One entry per selected job, in first-selected order. */
  selections: SolutionSelection[];
  provenance: {
    source: typeof SOLUTION_PROJECTION_PROVENANCE.source;
    sourcePr: typeof SOLUTION_PROJECTION_PROVENANCE.sourcePr;
    sourceSha: typeof SOLUTION_PROJECTION_PROVENANCE.sourceSha;
    basis: typeof SOLUTION_PROJECTION_PROVENANCE.basis;
  };
  feasibilityAsserted: false;
  grantsMergeAuthority: false;
}

/** Thrown for malformed input. The message names the offending field. */
export class SolutionProjectionError extends Error {
  override name = 'SolutionProjectionError';
}

const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function checkRow(row: unknown, index: number): SolutionVariableRow {
  const where = `rows[${index}]`;
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new SolutionProjectionError(`${where} must be an object`);
  }
  const r = row as Record<string, unknown>;
  for (const key of ['name', 'jobId', 'poolId'] as const) {
    if (!isNonEmpty(r[key])) throw new SolutionProjectionError(`${where}.${key} must be a non-empty string`);
  }
  if (r.consumer !== null && !isNonEmpty(r.consumer)) {
    throw new SolutionProjectionError(`${where}.consumer must be a non-empty string or null`);
  }
  if (typeof r.coefficient !== 'number' || !Number.isFinite(r.coefficient)) {
    throw new SolutionProjectionError(`${where}.coefficient must be a finite number`);
  }
  // Copy each field once: reads happen exactly once, and no caller object is retained.
  return {
    name: r.name as string,
    jobId: r.jobId as string,
    poolId: r.poolId as string,
    consumer: r.consumer as string | null,
    coefficient: r.coefficient,
  };
}

/**
 * Project a recorded solver result onto the assignment it selected. Pure and
 * non-mutating; returns fresh objects. Throws SolutionProjectionError on
 * malformed input. Never infers success, availability or feasibility.
 */
export function projectRecordedSolution(
  rows: readonly SolutionVariableRow[],
  primalValues: RecordedPrimalValues,
): SolutionProjection {
  if (!Array.isArray(rows)) throw new SolutionProjectionError('rows must be an array');
  if (typeof primalValues !== 'object' || primalValues === null || Array.isArray(primalValues)) {
    throw new SolutionProjectionError('primalValues must be an object keyed by variable name');
  }
  for (const key of Object.keys(primalValues)) {
    const value: unknown = primalValues[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SolutionProjectionError(`primalValues[${JSON.stringify(key)}] must be a finite number`);
    }
  }

  const variables: SolutionVariableRow[] = [];
  const names = new Set<string>();
  rows.forEach((row, index) => {
    const checked = checkRow(row, index);
    if (names.has(checked.name)) {
      throw new SolutionProjectionError(`duplicate variable name ${JSON.stringify(checked.name)}`);
    }
    names.add(checked.name);
    variables.push(checked);
  });

  // Map insertion order is first-selected order; replacing a value keeps the key's position.
  const chosen = new Map<string, SolutionVariableRow>();
  for (const variable of variables) {
    const primal = Object.prototype.hasOwnProperty.call(primalValues, variable.name)
      ? primalValues[variable.name]
      : 0;
    if (primal < SOLUTION_SELECTION_THRESHOLD) continue;
    const current = chosen.get(variable.jobId);
    if (!current || variable.coefficient > current.coefficient) chosen.set(variable.jobId, variable);
  }

  return {
    selections: [...chosen.values()].map((v) => ({
      jobId: v.jobId,
      poolId: v.poolId,
      consumer: v.consumer,
      variableName: v.name,
      coefficient: v.coefficient,
    })),
    provenance: { ...SOLUTION_PROJECTION_PROVENANCE },
    feasibilityAsserted: false,
    grantsMergeAuthority: false,
  };
}
