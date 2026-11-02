import { describe, expect, it } from 'vitest';
import { laneAsOf, sourceLabel, staleness, type ResourceLaneRow } from './fleet-ledger-model.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe('fleet ledger source and age', () => {
  it('labels known sources and only displays safe unknown tokens', () => {
    expect(sourceLabel('codex-personal-sessions')).toBe('personal Codex session logs');
    expect(sourceLabel('status')).toBe('dispatchd status');
    expect(sourceLabel('provider-api')).toBe('provider-api');
    expect(sourceLabel('/fake/private/path')).toBe('unknown');
    expect(sourceLabel('x'.repeat(41))).toBe('unknown');
    expect(sourceLabel(null)).toBe('unknown');
  });
  it('marks readings stale at 15 minutes and handles unknown timestamps', () => {
    expect(staleness(at(5), now)).toEqual({ state: 'fresh', text: 'as of 06:55 ET' });
    expect(staleness(at(16), now)).toEqual({ state: 'stale', text: 'as of 06:44 ET' });
    expect(staleness(at(15), now).state).toBe('stale');
    expect(staleness(at(5), now, 4 * 60_000).state).toBe('stale');
    for (const value of [null, 'not a date', at(-1)]) {
      expect(staleness(value, now)).toEqual({ state: 'unknown', text: 'age unknown' });
    }
  });
  it('uses the personal session observation rather than a newer status tick', () => {
    const row = { source: 'codex-personal-sessions', observation: { source: 'codex-personal-sessions', asOf: at(20) } } as ResourceLaneRow;
    expect(laneAsOf(row, at(1))).toBe(at(20));
    expect(laneAsOf({ ...row, observation: { source: 'other', asOf: at(20) } }, at(1))).toBeNull();
    expect(laneAsOf({ ...row, observation: null }, at(1))).toBeNull();
    expect(laneAsOf({ ...row, source: 'status' }, at(1))).toBe(at(1));
  });
});
