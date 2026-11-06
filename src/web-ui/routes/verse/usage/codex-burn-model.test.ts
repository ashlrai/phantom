import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pacePerHour, readCodexPersonal, readings, recordReading, requiredPacePerHour, resetReadings, stall, stallText, verdict } from './codex-burn-model.js';

const hour = 3_600_000;
const reading = { usedPct: 64, resetsAt: '2026-01-01T03:00:00Z', asOf: '2026-01-01T00:00:00Z', sourceState: 'healthy' as const };
const raw = { sources: { codex: 'healthy' }, codexPersonal: reading };
beforeEach(() => resetReadings());
afterEach(() => vi.restoreAllMocks());
describe('personal reading', () => {
  it('narrows the response and rejects invalid percentages and dates', () => {
    expect(readCodexPersonal(raw)).toEqual(reading);
    expect(readCodexPersonal({ ...raw, codexPersonal: { ...reading, usedPct: null } })?.usedPct).toBeNull();
    expect(readCodexPersonal({ ...raw, codexPersonal: { ...reading, usedPct: 101 } })).toBeNull();
    expect(readCodexPersonal({ ...raw, codexPersonal: { ...reading, asOf: 'bad' } })).toBeNull();
    expect(readCodexPersonal({ ...raw, sources: {} })).toBeNull();
    expect(readCodexPersonal({ ...raw, codexPersonal: null })).toBeNull();
  });
  it('computes observed and required pace only with enough time', () => {
    expect(pacePerHour([{ at: 0, usedPct: 10 }, { at: hour, usedPct: 13.2 }], hour)).toBeCloseTo(3.2);
    expect(pacePerHour([{ at: 0, usedPct: 10 }, { at: 599_999, usedPct: 11 }], hour)).toBeNull();
    expect(requiredPacePerHour(64, reading.resetsAt, Date.parse('2026-01-01T00:00:00Z'))).toBe(12);
    expect(requiredPacePerHour(64, reading.resetsAt, Date.parse('2026-01-01T03:00:00Z'))).toBeNull();
  });
  it('describes a stall and verdict', () => {
    const list = [{ at: 0, usedPct: 10 }, { at: hour, usedPct: 11 }, { at: 2 * hour, usedPct: 11 }];
    expect(stall(list, 72 * 60_000)).toBe(72 * 60_000);
    expect(stallText(59 * 60_000)).toBeNull();
    expect(stallText(72 * 60_000)).toBe('No movement for 1 h 12 min: check dispatch.');
    expect(verdict(10, 9.5)).toEqual({ state: 'ahead', text: 'On pace to use it all before the reset' });
    expect(verdict(3.2, 9.5).text).toBe('Behind: needs 9.5 points/h, running 3.2');
    expect(verdict(null, 9.5).text).toBe('Pace unknown yet');
  });
  it('persists and deduplicates observations across module reloads', async () => {
    recordReading({ ...reading, asOf: null }, 0);
    expect(readings()).toHaveLength(0);
    recordReading(reading, 0);
    recordReading(reading, 1);
    expect(readings()).toHaveLength(1);
    vi.resetModules();
    const reloaded = await import('./codex-burn-model.js');
    expect(reloaded.readings()).toEqual([{ at: Date.parse(reading.asOf), usedPct: 64 }]);
    reloaded.resetReadings();
  });
  it('keeps readings in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('denied'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw Error('denied'); });
    resetReadings();
    recordReading(reading, 0);
    expect(readings()).toHaveLength(1);
    resetReadings();
  });
});
