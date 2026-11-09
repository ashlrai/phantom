import { describe, expect, it } from 'vitest';
import { personalSessionCurrent } from './personal-session-freshness.js';

const now = Date.parse('2026-11-06T22:00:00.000Z');
const reading = { sourceState: 'healthy' as const, usedPct: 90,
  asOf: new Date(now - 60_000).toISOString(), resetsAt: new Date(now + 86_400_000).toISOString() };

describe('session usage display freshness', () => {
  it('uses the original observation time and expires without another response', () => {
    expect(personalSessionCurrent(reading, now)).toBe(true);
    expect(personalSessionCurrent(reading, now + 15 * 60_000)).toBe(false);
    expect(personalSessionCurrent(reading, now, 30_000)).toBe(false);
  });
  it('does not treat a successful file read as fresh usage after a reset or clock error', () => {
    for (const altered of [
      { ...reading, asOf: new Date(now + 1).toISOString() },
      { ...reading, asOf: 'not a date' },
      { ...reading, resetsAt: new Date(now).toISOString() },
      { ...reading, sourceState: 'degraded' as const },
    ]) expect(personalSessionCurrent(altered, now)).toBe(false);
    expect(personalSessionCurrent(null, now)).toBe(false);
    expect(personalSessionCurrent(reading, now, Number.NaN)).toBe(false);
  });
  it('keeps unknown resets explicit without inventing an account binding', () => {
    expect(personalSessionCurrent({ ...reading, resetsAt: null }, now)).toBe(true);
  });
});
