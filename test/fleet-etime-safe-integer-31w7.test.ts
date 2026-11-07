/**
 * Safe-integer guard for parseEtime — malformed huge day fields.
 *
 * Extends the existing parseEtime tests: valid formats retain exact values,
 * hundreds of day digits and totals above MAX_SAFE_INTEGER return null,
 * the exact largest representable boundary is included, and invalid
 * minutes / seconds / empty input still return null.
 */
import { describe, expect, it } from 'vitest';

import { parseEtime } from '../src/core/fleet/runs-live-workers.js';

describe('parseEtime — safe-integer guard (31w7)', () => {
  it('retains exact values for documented valid formats', () => {
    expect(parseEtime('05:12')).toBe(312);
    expect(parseEtime('00:07')).toBe(7);
    expect(parseEtime('02:03:04')).toBe(7384);
    expect(parseEtime('1-02:03:04')).toBe(93784);
    expect(parseEtime('12-00:00:00')).toBe(1036800);
  });

  it('returns null for invalid minutes (>= 60)', () => {
    expect(parseEtime('60:00')).toBeNull();
    expect(parseEtime('99:00')).toBeNull();
    expect(parseEtime('1-60:00')).toBeNull();
    expect(parseEtime('1-23:60')).toBeNull();
  });

  it('returns null for invalid seconds (>= 60)', () => {
    expect(parseEtime('05:60')).toBeNull();
    expect(parseEtime('02:03:60')).toBeNull();
    expect(parseEtime('1-02:03:60')).toBeNull();
  });

  it('returns null for empty, bare dash, and whitespace-only inputs', () => {
    expect(parseEtime('')).toBeNull();
    expect(parseEtime('-')).toBeNull();
    expect(parseEtime('   ')).toBeNull();
  });

  it('returns null for hundreds-of-digits day fields', () => {
    const hugeDays = '9'.repeat(500);
    expect(parseEtime(`${hugeDays}-00:00:00`)).toBeNull();
    expect(parseEtime(`${hugeDays}0`)).toBeNull();
    expect(parseEtime(`${hugeDays}-23:59:59`)).toBeNull();
  });

  it('returns exact values for large but safe day counts', () => {
    expect(parseEtime('99999-23:59:59')).toBe(8639999999);
    expect(parseEtime('99999-00:00:00')).toBe(8639913600);
  });

  it('returns null when the total exceeds Number.MAX_SAFE_INTEGER', () => {
    // 104258487693 days * 86400 > MAX_SAFE_INTEGER
    const overDays = '10425848769300';
    expect(parseEtime(`${overDays}-00:00:00`)).toBeNull();
    expect(parseEtime(`${overDays}-23:59:59`)).toBeNull();
  });

  it('covers the exact largest representable boundary', () => {
    const maxSafe = Number.MAX_SAFE_INTEGER;
    const maxDaysAtZero = Math.floor(maxSafe / 86400);
    expect(parseEtime(`${maxDaysAtZero}-00:00:00`)).toBe(maxDaysAtZero * 86400);
    expect(parseEtime(`${maxDaysAtZero + 1}-00:00:00`)).toBeNull();
  });

  it('preserves valid hh:mm:ss and dd-hh:mm:ss without day overflow', () => {
    expect(parseEtime('00:00:00')).toBe(0);
    expect(parseEtime('23:59:59')).toBe(86399);
    expect(parseEtime('0-23:59:59')).toBe(86399);
    expect(parseEtime('99999-23:59:59')).toBe(8639999999);
  });
});
