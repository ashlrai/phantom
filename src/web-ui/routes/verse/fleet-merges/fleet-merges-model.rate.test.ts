import { describe, expect, it } from 'vitest';
import { readMerges } from './fleet-merges-model.js';

describe('lane merge rate normalization', () => {
  it.each([
    [0.627, 62.7],
    [1, 100],
    [75, 75],
    [100, 100],
    [0, 0],
    [null, null],
    [NaN, null],
    [Infinity, null],
    [-0.1, null],
    [100.1, null],
    ['75', null],
  ])('normalizes %s to %s', (input, expected) => {
    const { lanes } = readMerges({ lanes: [{ lane: 'fake-lane', merged24h: 42, mergeRate24h: input }] });
    expect(lanes[0].mergeRate24h).toBe(expected);
  });
});
