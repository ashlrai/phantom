import { describe, expect, it } from 'vitest';
import { derivePulse, formatDuration, readPulseInput, STALL_MS, type PulseInput } from './merge-pulse-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const fixture = (over: Partial<PulseInput> = {}): PulseInput => ({
  generatedAt: new Date(now).toISOString(), lastTick: null, paused: false, claudeLane: null,
  workers: [{ ageSeconds: 1800 }], mergesLastHour: { count: 0 }, events: [], ...over,
});

describe('merge pulse model', () => {
  it('incidents at exactly 30 minutes, but not 29', () => {
    expect(derivePulse(fixture(), now).state).toBe('incident');
    expect(derivePulse(fixture({ workers: [{ ageSeconds: (STALL_MS - 60_000) / 1000 }] }), now).state).toBe('calm');
  });
  it('never treats an unknown merge count as zero', () => {
    expect(derivePulse(fixture({ mergesLastHour: { count: null } }), now).state).toBe('calm');
    expect(derivePulse(fixture({ workers: [], mergesLastHour: { count: null } }), now).state).toBe('unknown');
  });
  it('paused wins, including the Claude lane explanation', () => {
    expect(derivePulse(fixture({ paused: true, claudeLane: 'down' }), now)).toMatchObject({ state: 'paused', headline: 'Fleet paused', detail: 'Claude lane: down' });
  });
  it('uses the newest launch/start event when workers are absent', () => {
    const pulse = derivePulse(fixture({ workers: [], events: [
      { at: new Date(now - STALL_MS).toISOString(), kind: 'start' },
      { at: new Date(now - 60_000).toISOString(), kind: 'worker.launch' },
      { at: new Date(now).toISOString(), kind: 'tick' },
    ] }), now);
    expect(pulse).toMatchObject({ state: 'calm', lastStartAgoMs: 60_000 });
  });
  it('uses the youngest known worker age', () => {
    expect(derivePulse(fixture({ workers: [{ ageSeconds: null }, { ageSeconds: 2000 }, { ageSeconds: 180 }] }), now).headline).toBe('Last start 3 min ago · no merges yet');
  });
  it('keeps missing starts explicit', () => {
    expect(derivePulse(fixture({ workers: [] }), now).headline).toContain('nothing started yet');
    expect(derivePulse(fixture({ workers: [], mergesLastHour: { count: 4 } }), now).headline).toBe('Nothing started yet · 4 merged in the last hour');
  });
  it('returns unknown for null and rejects malformed snapshots', () => {
    expect(derivePulse(null, now).state).toBe('unknown');
    expect(readPulseInput(fixture())).not.toBeNull();
    for (const value of [null, {}, fixture({ workers: [{ ageSeconds: NaN }] }), { ...fixture(), mergesLastHour: {} }]) expect(readPulseInput(value)).toBeNull();
  });
  it.each([[0, '< 1 min'], [59_999, '< 1 min'], [60_000, '1 min'], [3_660_000, '1 h 1 min']])('formats %i ms', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
