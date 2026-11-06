import { describe, expect, it } from 'vitest';
import { etaText, GRACE_MS, LEADER_PASS_CADENCE_MS, nextPassEta } from './next-pass-eta.js';

describe('next leader pass ETA', () => {
  it('rounds up remaining minutes and holds at one through the grace period', () => {
    const due = LEADER_PASS_CADENCE_MS;
    expect(nextPassEta(0, due - 60_001)).toEqual({ kind: 'due-in', minutes: 2 });
    expect(nextPassEta(0, due - 60_000)).toEqual({ kind: 'due-in', minutes: 1 });
    expect(nextPassEta(0, due)).toEqual({ kind: 'due-in', minutes: 1 });
    expect(nextPassEta(0, due + GRACE_MS - 1)).toEqual({ kind: 'due-in', minutes: 1 });
  });

  it('counts overdue time from the cadence, starting at the grace boundary', () => {
    const due = LEADER_PASS_CADENCE_MS;
    expect(nextPassEta(0, due + GRACE_MS)).toEqual({ kind: 'overdue', minutes: 3 });
    expect(nextPassEta(0, due + GRACE_MS + 1)).toEqual({ kind: 'overdue', minutes: 4 });
    expect(nextPassEta(0, 10 * 60_000, 5 * 60_000)).toEqual({ kind: 'overdue', minutes: 5 });
  });

  it('formats all states and handles an unknown pass', () => {
    expect(nextPassEta(null, 0)).toEqual({ kind: 'unknown' });
    expect(nextPassEta(NaN, 0)).toEqual({ kind: 'unknown' });
    expect(etaText({ kind: 'unknown' })).toBe('next pass unknown');
    expect(etaText({ kind: 'due-in', minutes: 6 })).toBe('next pass in ~6 min');
    expect(etaText({ kind: 'overdue', minutes: 9 })).toBe('pass overdue by 9 min');
  });
});
