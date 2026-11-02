import { describe, expect, it } from 'vitest';
import { easternClock } from '../usage/fleet-ledger-model.js';
import { personalRunwayText } from './personal-runway-text.js';

const nowMs = Date.parse('2026-10-31T12:00:00.000Z');

describe('personalRunwayText', () => {
  it('returns null when usage or a positive pace is unavailable', () => {
    expect(personalRunwayText({ usedPct: null, pacePerHour: 2, nowMs })).toBeNull();
    expect(personalRunwayText({ usedPct: 92, pacePerHour: null, nowMs })).toBeNull();
    expect(personalRunwayText({ usedPct: 92, pacePerHour: 0, nowMs })).toBeNull();
    expect(personalRunwayText({ usedPct: 92, pacePerHour: -1, nowMs })).toBeNull();
  });

  it('projects a clock time, exhaustion, or days remaining', () => {
    expect(personalRunwayText({ usedPct: 92, pacePerHour: 2, nowMs }))
      .toBe(`out near ${easternClock(nowMs + 4 * 3_600_000)} at 2.0%/h`);
    expect(personalRunwayText({ usedPct: 100, pacePerHour: 2, nowMs })).toBe('out of personal Codex');
    expect(personalRunwayText({ usedPct: 10, pacePerHour: 0.5, nowMs })).toBe('about 8 days left at 0.5%/h');
  });
});
