import { describe, expect, it } from 'vitest';
import { parsePressureLevel } from '../contrib/mac/memguard/mac.js';

describe('parsePressureLevel (standalone)', () => {
  it.each([
    ['1\n', 1],
    ['2\n', 2],
    ['4\n', 4],
  ])('returns the integer level for valid input: %s', (output, expected) => {
    expect(parsePressureLevel(output)).toBe(expected);
  });

  it.each([
    ['', null],
    ['-1', null],
    ['-42', null],
    ['0abc', null],
    ['1.5', null],
    ['NaN', null],
  ])('returns null for empty, negative or non-numeric: %s', (output, expected) => {
    expect(parsePressureLevel(output)).toBe(expected);
  });
});