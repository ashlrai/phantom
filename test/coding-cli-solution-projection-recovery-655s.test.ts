import { describe, expect, it } from 'vitest';

import {
  projectRecordedSolution,
  SOLUTION_PROJECTION_PROVENANCE,
  SolutionProjectionError,
  type RecordedPrimalValues,
  type SolutionVariableRow,
} from '../src/core/providers/coding-cli/solution-projection.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) chosenFromSolution(). Synthetic identities only.
const r = (name: string, jobId: string, poolId: string, consumer: string | null, coefficient: number) =>
  ({ name, jobId, poolId, consumer, coefficient }) satisfies SolutionVariableRow;

// Hand-calculated source-equivalent record (see BRIDGE_NOTES.md):
//   job-1: x-a(2, 1.0) x-b(5, 0.7) -> x-b | job-2: x-c(1, 1.0) x-d(1, 1.0) -> x-c (tie, first kept)
//   job-3: x-e(-1, 0.9) x-f(-3, 0.6) -> x-e | job-4: x-g(4, 0.499) x-h(1, 0.5) -> x-h
//   job-5: x-i(9, absent) -> none | x-unknown(1.0) has no row -> ignored
const SOURCE_ROWS = [
  r('x-a', 'job-1', 'pool-a', null, 2),
  r('x-b', 'job-1', 'pool-b', 'cons-1', 5),
  r('x-c', 'job-2', 'pool-a', null, 1),
  r('x-d', 'job-2', 'pool-c', 'cons-2', 1),
  r('x-e', 'job-3', 'pool-b', null, -1),
  r('x-f', 'job-3', 'pool-c', null, -3),
  r('x-g', 'job-4', 'pool-a', null, 4),
  r('x-h', 'job-4', 'pool-b', null, 1),
  r('x-i', 'job-5', 'pool-a', null, 9),
];
const SOURCE_VALUES: RecordedPrimalValues = {
  'x-a': 1, 'x-b': 0.7, 'x-c': 1, 'x-d': 1, 'x-e': 0.9, 'x-f': 0.6, 'x-g': 0.499, 'x-h': 0.5, 'x-unknown': 1,
};

const selectedNames = (rows: readonly SolutionVariableRow[], values: RecordedPrimalValues) =>
  projectRecordedSolution(rows, values).selections.map((s) => s.variableName);

describe('projectRecordedSolution', () => {
  it('reproduces the hand-calculated selections in first-selected order, with fixed provenance flags', () => {
    const projection = projectRecordedSolution(SOURCE_ROWS, SOURCE_VALUES);
    expect(projection.selections).toEqual([
      { jobId: 'job-1', poolId: 'pool-b', consumer: 'cons-1', variableName: 'x-b', coefficient: 5 },
      { jobId: 'job-2', poolId: 'pool-a', consumer: null, variableName: 'x-c', coefficient: 1 },
      { jobId: 'job-3', poolId: 'pool-b', consumer: null, variableName: 'x-e', coefficient: -1 },
      { jobId: 'job-4', poolId: 'pool-b', consumer: null, variableName: 'x-h', coefficient: 1 },
    ]);
    expect(projection.provenance).toEqual(SOLUTION_PROJECTION_PROVENANCE);
    expect(projection.feasibilityAsserted).toBe(false);
    expect(projection.grantsMergeAuthority).toBe(false);
  });

  it('applies the 0.5 threshold: 0.499 and 0.4999999 not selected, 0.5 selected, negatives not selected', () => {
    const rows = [r('below', 'j1', 'p', null, 1), r('at', 'j2', 'p', null, 1), r('neg', 'j3', 'p', null, 1)];
    expect(selectedNames(rows, { below: 0.499, at: 0.5, neg: -1 })).toEqual(['at']);
    expect(selectedNames(rows, { below: 0.4999999 })).toEqual([]);
  });

  it('selects fractional values such as 0.7 by the same rule', () => {
    expect(selectedNames([r('frac', 'j1', 'p', null, 1)], { frac: 0.7 })).toEqual(['frac']);
  });

  it('treats absent values and empty input as nothing selected', () => {
    expect(selectedNames([r('absent', 'j1', 'p', null, 100)], {})).toEqual([]);
    expect(projectRecordedSolution([], {}).selections).toEqual([]);
  });

  it('orders jobs by first selection, not by the winning variable position', () => {
    const rows = [r('a1', 'job-A', 'p', null, 1), r('b1', 'job-B', 'p', null, 1), r('a2', 'job-A', 'q', null, 9)];
    const { selections } = projectRecordedSolution(rows, { a1: 1, b1: 1, a2: 1 });
    expect(selections.map((s) => [s.jobId, s.variableName])).toEqual([
      ['job-A', 'a2'],
      ['job-B', 'b1'],
    ]);
  });

  it('picks the highest coefficient regardless of row order, and only among selected variables', () => {
    const lo = r('lo', 'j1', 'p', null, 1);
    const hi = r('hi', 'j1', 'q', 'c', 7);
    expect(selectedNames([lo, hi], { lo: 1, hi: 1 })).toEqual(['hi']);
    expect(selectedNames([hi, lo], { lo: 1, hi: 1 })).toEqual(['hi']);
    expect(selectedNames([lo, hi], { lo: 1, hi: 0.49 })).toEqual(['lo']);
  });

  it('keeps the first encountered variable on an equal-coefficient tie', () => {
    const first = r('first', 'j1', 'p', null, 3);
    const second = r('second', 'j1', 'q', null, 3);
    expect(selectedNames([first, second], { first: 1, second: 1 })).toEqual(['first']);
    expect(selectedNames([first, second], { second: 1 })).toEqual(['second']);
  });

  it('keeps the largest negative coefficient', () => {
    const rows = [r('m3', 'j1', 'p', null, -3), r('m1', 'j1', 'q', null, -1)];
    expect(projectRecordedSolution(rows, { m3: 1, m1: 1 }).selections).toEqual([
      { jobId: 'j1', poolId: 'q', consumer: null, variableName: 'm1', coefficient: -1 },
    ]);
  });

  it('ignores finite values for unknown names and inherited Object.prototype keys', () => {
    expect(selectedNames([r('known', 'j1', 'p', null, 1)], { known: 0, ghost: 1 })).toEqual([]);
    expect(selectedNames([r('constructor', 'j1', 'p', null, 1)], {})).toEqual([]);
  });

  it('does not mutate frozen inputs and returns fresh results', () => {
    const rows = Object.freeze(SOURCE_ROWS.map((row) => Object.freeze({ ...row })));
    const values = Object.freeze({ ...SOURCE_VALUES });
    const before = JSON.stringify([rows, values]);
    const first = projectRecordedSolution(rows, values);
    expect(JSON.stringify([rows, values])).toBe(before);

    first.selections.pop();
    first.selections[0]!.jobId = 'tampered';
    (first.provenance as { basis: string }).basis = 'tampered';
    const second = projectRecordedSolution(rows, values);
    expect(second.selections).toHaveLength(4);
    expect(second.selections[0]?.jobId).toBe('job-1');
    expect(second.provenance.basis).toBe('recorded-primal-values');
  });
});

describe('projectRecordedSolution validation', () => {
  const good = r('ok', 'j1', 'p', null, 1);
  const rejects = (fn: () => unknown, pattern: RegExp) => {
    expect(fn).toThrow(SolutionProjectionError);
    expect(fn).toThrow(pattern);
  };

  it('rejects non-array rows and non-object rows', () => {
    rejects(() => projectRecordedSolution(good as unknown as SolutionVariableRow[], {}), /rows must be an array/);
    for (const bad of [null, [], 'x']) {
      rejects(() => projectRecordedSolution([bad] as unknown as SolutionVariableRow[], {}), /rows\[0\] must be/);
    }
  });

  it('rejects empty or whitespace-only identities and malformed consumers', () => {
    for (const field of ['name', 'jobId', 'poolId'] as const) {
      for (const bad of ['', '   ', '\t']) {
        rejects(() => projectRecordedSolution([{ ...good, [field]: bad }], { ok: 1 }), new RegExp(`${field} must be`));
      }
    }
    for (const bad of [undefined, '', 0]) {
      rejects(() => projectRecordedSolution([{ ...good, consumer: bad as unknown as null }], { ok: 1 }), /consumer/);
    }
  });

  it('rejects non-finite or non-numeric coefficients', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', null]) {
      rejects(
        () => projectRecordedSolution([{ ...good, coefficient: bad as unknown as number }], { ok: 1 }),
        /coefficient must be a finite number/,
      );
    }
  });

  it('rejects duplicate variable names', () => {
    rejects(() => projectRecordedSolution([good, r('ok', 'j2', 'q', null, 2)], { ok: 1 }), /duplicate variable name "ok"/);
  });

  it('rejects non-finite primal values, including for names with no row', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      rejects(() => projectRecordedSolution([good], { ok: bad as unknown as number }), /finite number/);
      rejects(() => projectRecordedSolution([good], { ok: 1, ghost: bad as unknown as number }), /finite number/);
    }
    rejects(() => projectRecordedSolution([good], [] as unknown as RecordedPrimalValues), /primalValues must be/);
    rejects(() => projectRecordedSolution([good], null as unknown as RecordedPrimalValues), /primalValues must be/);
  });
});
