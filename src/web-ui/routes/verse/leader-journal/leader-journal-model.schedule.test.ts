import { describe, expect, it } from 'vitest';
import { passSchedule, type JournalPass } from './leader-journal-model.js';

const minute = 60_000;
const pass = (at: number): JournalPass => ({ at: new Date(at).toISOString(), sections: [] });
const start = Date.parse('2026-01-01T12:00:00Z');

describe('passSchedule', () => {
  it('uses the newest pass, regardless of input order', () => {
    expect(passSchedule([pass(start - minute), pass(start)], start + 9 * minute)).toEqual({
      lastAtMs: start, eta: { kind: 'due-in', minutes: 6 }, text: 'next pass in ~6 min', tone: 'ok',
    });
  });
  it('keeps a pass in the grace period due soon', () => {
    expect(passSchedule([pass(start)], start + 17 * minute)).toMatchObject({
      eta: { kind: 'due-in', minutes: 1 }, text: 'next pass in ~1 min', tone: 'ok',
    });
  });
  it('warns when overdue by 12 minutes', () => {
    expect(passSchedule([pass(start)], start + 27 * minute)).toMatchObject({
      eta: { kind: 'overdue', minutes: 12 }, text: 'pass overdue by 12 min', tone: 'warning',
    });
  });
  it('turns dangerous only after 30 minutes overdue', () => {
    expect(passSchedule([pass(start)], start + 45 * minute).tone).toBe('warning');
    expect(passSchedule([pass(start)], start + 45 * minute + 1).tone).toBe('danger');
    expect(passSchedule([pass(start)], start + 55 * minute)).toMatchObject({
      eta: { kind: 'overdue', minutes: 40 }, text: 'pass overdue by 40 min', tone: 'danger',
    });
  });
  it('warns when there are no passes or no usable timestamps', () => {
    expect(passSchedule([], start)).toEqual({ lastAtMs: null, eta: null, text: 'no pass recorded yet', tone: 'warning' });
    expect(passSchedule([{ at: 'invalid', sections: [] }], start)).toEqual({
      lastAtMs: null, eta: { kind: 'unknown' }, text: 'next pass unknown', tone: 'warning',
    });
  });
});
