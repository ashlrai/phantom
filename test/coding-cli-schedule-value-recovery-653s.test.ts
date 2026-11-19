import { describe, expect, it } from 'vitest';

import {
  summarizeScheduleValue,
  type ScheduleValueRow,
} from '../src/core/providers/coding-cli/schedule-value-summary.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) eventsFromSchedule() per-pool loop.
// Every pool identifier and number here is synthetic.

function row(poolId: string, netValue: number, monetaryCost: number): ScheduleValueRow {
  return { poolId, netValue, monetaryCost };
}

/** A mixed-pool fixture. Dyadic costs keep the expected sums exact. */
const MIXED: readonly ScheduleValueRow[] = [
  row('synthetic-a', 2, 1),
  row('synthetic-b', 3, 0.5),
  row('synthetic-a', -1, 0.25),
  row('synthetic-c', 4, 2),
  row('synthetic-b', 1, 0.5),
];

describe('summarizeScheduleValue totals', () => {
  it('matches independently calculated mixed-pool totals', () => {
    // synthetic-a: value 2 + -1 = 1, cost 1 + 0.25 = 1.25, jobs 2, ratio 1 / 1.25 = 0.8
    // synthetic-b: value 3 + 1 = 4, cost 0.5 + 0.5 = 1, jobs 2, ratio 4
    // synthetic-c: value 4, cost 2, jobs 1, ratio 2
    const out = summarizeScheduleValue(MIXED);
    expect(out.map((p) => p.poolId)).toEqual(['synthetic-a', 'synthetic-b', 'synthetic-c']);
    expect(out[0]).toMatchObject({ jobs: 2, expectedValue: 1, monetaryCost: 1.25, provenance: 'historical-offline' });
    expect(out[0].valuePerDollar).toBeCloseTo(0.8, 12);
    expect(out[1]).toMatchObject({ jobs: 2, expectedValue: 4, monetaryCost: 1, valuePerDollar: 4 });
    expect(out[2]).toMatchObject({ jobs: 1, expectedValue: 4, monetaryCost: 2, valuePerDollar: 2 });
  });

  it('keeps first-seen pool order regardless of later repeats', () => {
    const out = summarizeScheduleValue([
      row('synthetic-z', 1, 1),
      row('synthetic-m', 1, 1),
      row('synthetic-z', 1, 1),
      row('synthetic-a', 1, 1),
    ]);
    expect(out.map((p) => p.poolId)).toEqual(['synthetic-z', 'synthetic-m', 'synthetic-a']);
  });

  it('accumulates a repeated pool across every row', () => {
    const repeated = Array.from({ length: 5 }, () => row('synthetic-r', 0.5, 0.25));
    const [only] = summarizeScheduleValue(repeated);
    expect(only).toMatchObject({ poolId: 'synthetic-r', jobs: 5, expectedValue: 2.5, monetaryCost: 1.25, valuePerDollar: 2 });
    expect(summarizeScheduleValue(repeated)).toHaveLength(1);
  });

  it('keeps a negative net value and reports a negative ratio', () => {
    const [only] = summarizeScheduleValue([row('synthetic-neg', -3, 1), row('synthetic-neg', -1, 1)]);
    expect(only).toMatchObject({ jobs: 2, expectedValue: -4, monetaryCost: 2, valuePerDollar: -2 });
  });

  it('returns null valuePerDollar when total cost is zero, even with positive value', () => {
    const out = summarizeScheduleValue([row('synthetic-free', 5, 0), row('synthetic-free', 2, 0)]);
    expect(out).toEqual([
      {
        poolId: 'synthetic-free',
        jobs: 2,
        expectedValue: 7,
        monetaryCost: 0,
        valuePerDollar: null,
        provenance: 'historical-offline',
      },
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(summarizeScheduleValue([])).toEqual([]);
  });

  it('does not mutate frozen input rows or the input array', () => {
    const rows = Object.freeze(MIXED.map((r) => Object.freeze({ ...r })));
    const before = JSON.stringify(rows);
    const out = summarizeScheduleValue(rows);
    expect(JSON.stringify(rows)).toBe(before);
    expect(out).toHaveLength(3);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out[0])).toBe(true);
  });
});

describe('summarizeScheduleValue rejects invalid input', () => {
  it.each([
    ['empty poolId', ''],
    ['whitespace poolId', '   '],
    ['non-string poolId', 7 as unknown as string],
  ])('rejects %s', (_label, poolId) => {
    expect(() => summarizeScheduleValue([row(poolId, 1, 1)])).toThrow(/poolId/);
  });

  it.each([
    ['NaN netValue', { netValue: Number.NaN, monetaryCost: 1 }, /netValue/],
    ['Infinity netValue', { netValue: Number.POSITIVE_INFINITY, monetaryCost: 1 }, /netValue/],
    ['string netValue', { netValue: '1' as unknown as number, monetaryCost: 1 }, /netValue/],
    ['NaN monetaryCost', { netValue: 1, monetaryCost: Number.NaN }, /monetaryCost/],
    ['-Infinity monetaryCost', { netValue: 1, monetaryCost: Number.NEGATIVE_INFINITY }, /monetaryCost/],
    ['negative monetaryCost', { netValue: 1, monetaryCost: -0.01 }, /non-negative/],
  ])('rejects %s', (_label, fields, pattern) => {
    expect(() => summarizeScheduleValue([row('synthetic-bad', fields.netValue, fields.monetaryCost)])).toThrow(pattern);
  });

  it('rejects a null row and names its index', () => {
    expect(() => summarizeScheduleValue([row('synthetic-ok', 1, 1), null as unknown as ScheduleValueRow])).toThrow(/row 1/);
  });

  it('rejects an invalid row anywhere in the list', () => {
    expect(() => summarizeScheduleValue([...MIXED, row('synthetic-bad', 1, -1)])).toThrow(/row 5/);
  });
});

describe('summarizeScheduleValue aggregate overflow', () => {
  it('rejects a summed value that overflows to Infinity', () => {
    expect(() =>
      summarizeScheduleValue([row('synthetic-big', Number.MAX_VALUE, 1), row('synthetic-big', Number.MAX_VALUE, 1)]),
    ).toThrow(/overflowed/);
  });

  it('rejects a summed cost that overflows to Infinity', () => {
    expect(() =>
      summarizeScheduleValue([row('synthetic-big', 1, Number.MAX_VALUE), row('synthetic-big', 1, Number.MAX_VALUE)]),
    ).toThrow(/overflowed/);
  });

  it('rejects a ratio that overflows to Infinity from a tiny positive cost', () => {
    expect(() => summarizeScheduleValue([row('synthetic-tiny', 1e308, Number.MIN_VALUE)])).toThrow(/valuePerDollar/);
  });
});

describe('source parity with PR #5952 eventsFromSchedule()', () => {
  it('reproduces the source per-pool arithmetic on a synthetic fixture', () => {
    // The source loop, transcribed from scheduler/telemetry.ts, over the same assignments.
    const byPool = new Map<string, { value: number; cost: number; jobs: number }>();
    for (const assignment of MIXED) {
      const current = byPool.get(assignment.poolId) ?? { value: 0, cost: 0, jobs: 0 };
      current.value += assignment.netValue;
      current.cost += assignment.monetaryCost;
      current.jobs += 1;
      byPool.set(assignment.poolId, current);
    }
    const sourceRows = [...byPool.entries()].map(([poolId, r]) => ({
      poolId,
      expectedValue: r.value,
      jobs: r.jobs,
      monetaryCost: r.cost,
      valuePerDollar: r.cost > 0 ? r.value / r.cost : null,
    }));

    const recovered = summarizeScheduleValue(MIXED).map(({ poolId, expectedValue, jobs, monetaryCost, valuePerDollar }) => ({
      poolId,
      expectedValue,
      jobs,
      monetaryCost,
      valuePerDollar,
    }));
    expect(recovered).toEqual(sourceRows);
  });
});
