import { describe, expect, it } from 'vitest';

import {
  normalizeRecordedSolverResult,
  RECORDED_SOLVER_RESULT_PROVENANCE,
  RecordedSolverResultError,
  type RecordedSolverMalformedReason,
  type RecordedSolverResult,
  type RecordedSolverTiming,
} from '../src/core/providers/coding-cli/recorded-solver-result.js';
import {
  projectRecordedSolution,
  type SolutionVariableRow,
} from '../src/core/providers/coding-cli/solution-projection.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) scheduler/solve.ts highsSolver(). Synthetic records only.
const WITHIN: RecordedSolverTiming = { elapsedMs: 40, budgetMs: 100 };
const OPTIMAL: RecordedSolverResult = {
  Status: 'Optimal',
  ObjectiveValue: 7.5,
  Columns: {
    'x-a': { Primal: 1 },
    'x-b': { Primal: 0.7 },
    'x-c': { Primal: 0 },
    'x-free': {},
  },
};

const reasonOf = (fn: () => unknown): RecordedSolverMalformedReason | 'no-throw' => {
  try {
    fn();
    return 'no-throw';
  } catch (error) {
    expect(error).toBeInstanceOf(RecordedSolverResultError);
    return (error as RecordedSolverResultError).reason;
  }
};

describe('normalizeRecordedSolverResult: source status mapping', () => {
  it('maps Optimal to optimal with objective and own numeric Primal values', () => {
    const out = normalizeRecordedSolverResult(OPTIMAL, WITHIN);
    expect(out.status).toBe('optimal');
    expect(out.objective).toBe(7.5);
    // Columns without a Primal are skipped, as in the source; zero is a recorded value.
    expect(out.values).toEqual({ 'x-a': 1, 'x-b': 0.7, 'x-c': 0 });
    expect(out.feasibilityAsserted).toBe(false);
    expect(out.grantsMergeAuthority).toBe(false);
    expect(out.provenance).toEqual(RECORDED_SOLVER_RESULT_PROVENANCE);
    expect(out.provenance.grantsMergeAuthority).toBe(false);
  });

  it('maps Empty to optimal when the recorded objective is finite', () => {
    const out = normalizeRecordedSolverResult({ Status: 'Empty', ObjectiveValue: 0, Columns: {} }, WITHIN);
    expect(out).toMatchObject({ status: 'optimal', objective: 0, values: {} });
  });

  it('returns infeasible with null objective and empty values, even when elapsed exceeds budget', () => {
    const out = normalizeRecordedSolverResult(
      { Status: 'Infeasible', ObjectiveValue: 3, Columns: { 'x-a': { Primal: 1 } } },
      { elapsedMs: 500, budgetMs: 100 },
    );
    expect(out).toMatchObject({ status: 'infeasible', objective: null, values: {} });
  });

  it('returns timeout for an explicit Time limit reached status even within budget', () => {
    const out = normalizeRecordedSolverResult({ Status: 'Time limit reached', ObjectiveValue: 1, Columns: { a: { Primal: 1 } } }, WITHIN);
    expect(out).toMatchObject({ status: 'timeout', objective: null, values: {} });
  });

  it('treats elapsed equal to budget as not timed out, and elapsed greater than budget as timeout', () => {
    expect(normalizeRecordedSolverResult(OPTIMAL, { elapsedMs: 100, budgetMs: 100 }).status).toBe('optimal');
    const over = normalizeRecordedSolverResult(OPTIMAL, { elapsedMs: 100.001, budgetMs: 100 });
    expect(over).toMatchObject({ status: 'timeout', objective: null, values: {} });
  });

  it('maps an unknown status to failed within budget', () => {
    const out = normalizeRecordedSolverResult({ Status: 'Unbounded' }, WITHIN);
    expect(out).toMatchObject({ status: 'failed', objective: null, values: {} });
  });

  it('keeps the source precedence: an unknown status over budget is timeout, not failed', () => {
    expect(normalizeRecordedSolverResult({ Status: 'Unbounded' }, { elapsedMs: 200, budgetMs: 100 }).status).toBe('timeout');
  });
});

describe('normalizeRecordedSolverResult: malformed evidence throws, never becomes optimal', () => {
  it.each<[string, unknown, unknown, RecordedSolverMalformedReason]>([
    ['null result', null, WITHIN, 'result-not-object'],
    ['array result', [], WITHIN, 'result-not-object'],
    ['numeric Status', { Status: 1, ObjectiveValue: 1, Columns: {} }, WITHIN, 'status-not-string'],
    ['missing Status', { ObjectiveValue: 1, Columns: {} }, WITHIN, 'status-not-string'],
    ['null timing', OPTIMAL, null, 'timing-not-object'],
    ['NaN elapsed', OPTIMAL, { elapsedMs: NaN, budgetMs: 100 }, 'elapsed-ms-invalid'],
    ['Infinity elapsed', OPTIMAL, { elapsedMs: Infinity, budgetMs: 100 }, 'elapsed-ms-invalid'],
    ['negative elapsed', OPTIMAL, { elapsedMs: -1, budgetMs: 100 }, 'elapsed-ms-invalid'],
    ['zero budget', OPTIMAL, { elapsedMs: 1, budgetMs: 0 }, 'budget-ms-invalid'],
    ['negative budget', OPTIMAL, { elapsedMs: 1, budgetMs: -5 }, 'budget-ms-invalid'],
    ['NaN budget', OPTIMAL, { elapsedMs: 1, budgetMs: NaN }, 'budget-ms-invalid'],
    ['infinite budget', OPTIMAL, { elapsedMs: 1, budgetMs: Infinity }, 'budget-ms-invalid'],
    ['infinite objective', { Status: 'Optimal', ObjectiveValue: Infinity, Columns: {} }, WITHIN, 'objective-invalid'],
    ['missing objective for Empty', { Status: 'Empty', Columns: {} }, WITHIN, 'objective-invalid'],
    ['missing Columns', { Status: 'Optimal', ObjectiveValue: 1 }, WITHIN, 'columns-invalid'],
    ['array Columns', { Status: 'Optimal', ObjectiveValue: 1, Columns: [] }, WITHIN, 'columns-invalid'],
    ['null column record', { Status: 'Optimal', ObjectiveValue: 1, Columns: { a: null } }, WITHIN, 'column-invalid'],
    ['string Primal', { Status: 'Optimal', ObjectiveValue: 1, Columns: { a: { Primal: '1' } } }, WITHIN, 'primal-invalid'],
    ['NaN Primal', { Status: 'Optimal', ObjectiveValue: 1, Columns: { a: { Primal: NaN } } }, WITHIN, 'primal-invalid'],
    ['infinite Primal', { Status: 'Optimal', ObjectiveValue: 1, Columns: { a: { Primal: -Infinity } } }, WITHIN, 'primal-invalid'],
  ])('rejects %s', (_label, recorded, timing, reason) => {
    expect(reasonOf(() => normalizeRecordedSolverResult(recorded as RecordedSolverResult, timing as RecordedSolverTiming))).toBe(reason);
  });

  it('does not let malformed Columns turn a timed-out or failed record into a typed error', () => {
    // Columns are only read for optimal records; the outcome class alone decides these.
    expect(normalizeRecordedSolverResult({ Status: 'Unbounded', Columns: 5 } as unknown as RecordedSolverResult, WITHIN).status).toBe('failed');
  });

  it('still rejects malformed timing for an infeasible record (divergence: timing is always validated)', () => {
    expect(reasonOf(() => normalizeRecordedSolverResult({ Status: 'Infeasible' }, { elapsedMs: NaN, budgetMs: 1 }))).toBe('elapsed-ms-invalid');
  });
});

describe('normalizeRecordedSolverResult: own-entry, freshness and non-mutation', () => {
  it('ignores inherited Primal values and inherited Columns entries', () => {
    const inheritedPrimal = Object.create({ Primal: 9 }) as Record<string, unknown>;
    const out = normalizeRecordedSolverResult(
      { Status: 'Optimal', ObjectiveValue: 1, Columns: { own: inheritedPrimal, real: { Primal: 1 } } },
      WITHIN,
    );
    expect(out.values).toEqual({ real: 1 });

    const proto = Object.create({ inheritedColumn: { Primal: 5 } }) as Record<string, unknown>;
    proto.own = { Primal: 2 };
    expect(normalizeRecordedSolverResult({ Status: 'Optimal', ObjectiveValue: 1, Columns: proto }, WITHIN).values).toEqual({ own: 2 });
  });

  it('keeps a column literally named __proto__ as a plain data key', () => {
    const columns = JSON.parse('{"__proto__": {"Primal": 4}}') as Record<string, unknown>;
    const { values } = normalizeRecordedSolverResult({ Status: 'Optimal', ObjectiveValue: 1, Columns: columns }, WITHIN);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(values, '__proto__')?.value).toBe(4);
  });

  it('does not mutate inputs and returns fresh objects on every call', () => {
    const recorded = structuredClone(OPTIMAL);
    const timing = { ...WITHIN };
    const first = normalizeRecordedSolverResult(recorded, timing);
    const second = normalizeRecordedSolverResult(recorded, timing);
    expect(recorded).toEqual(OPTIMAL);
    expect(timing).toEqual(WITHIN);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.values).not.toBe(second.values);
    expect(first.provenance).not.toBe(second.provenance);
    first.values['x-a'] = 99;
    expect(second.values['x-a']).toBe(1);
    expect(RECORDED_SOLVER_RESULT_PROVENANCE.sourcePr).toBe(5952);
  });
});

describe('normalizeRecordedSolverResult: integration with projectRecordedSolution', () => {
  it('passes the optimal values to the existing projection, without asserting dispatch authority', () => {
    const rows: SolutionVariableRow[] = [
      { name: 'x-a', jobId: 'job-1', poolId: 'pool-a', consumer: null, coefficient: 2 },
      { name: 'x-b', jobId: 'job-1', poolId: 'pool-b', consumer: 'cons-1', coefficient: 5 },
      { name: 'x-c', jobId: 'job-2', poolId: 'pool-a', consumer: null, coefficient: 1 },
    ];
    const normalized = normalizeRecordedSolverResult(
      { Status: 'Optimal', ObjectiveValue: 3, Columns: { 'x-a': { Primal: 0 }, 'x-b': { Primal: 1 }, 'x-c': { Primal: 0.6 } } },
      WITHIN,
    );
    const projection = projectRecordedSolution(rows, normalized.values);
    expect(projection.selections.map((s) => s.variableName)).toEqual(['x-b', 'x-c']);
    expect(projection.grantsMergeAuthority).toBe(false);
    expect(projection.feasibilityAsserted).toBe(false);
  });

  it('projects nothing from a timed-out record because its values are empty', () => {
    const rows: SolutionVariableRow[] = [{ name: 'x-a', jobId: 'job-1', poolId: 'pool-a', consumer: null, coefficient: 1 }];
    const normalized = normalizeRecordedSolverResult({ Status: 'Optimal', ObjectiveValue: 1, Columns: { 'x-a': { Primal: 1 } } }, { elapsedMs: 2, budgetMs: 1 });
    expect(normalized.status).toBe('timeout');
    expect(projectRecordedSolution(rows, normalized.values).selections).toEqual([]);
  });
});
