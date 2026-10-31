import { afterEach, describe, expect, it } from 'vitest';
import { fleetLive } from '../command/fixtures.test-support.js';
import { describeLane, laneHistory, MAX_SAMPLES, recordLaneSamples, resetLaneHistory, summariseLane } from './lane-history-store.js';

const start = Date.parse('2026-01-01T00:00:00Z');
function snapshot(offset: number, busy: number) {
  return { ...fleetLive('live', start), generatedAt: new Date(start + offset).toISOString(), lanes: [{ lane: 'codex' as const, slots: 4, busy, capReason: null }] };
}

afterEach(resetLaneHistory);

describe('lane history', () => {
  it('samples each snapshot, deduplicates close and older timestamps, and retains missing lanes', () => {
    recordLaneSamples(snapshot(0, 1));
    recordLaneSamples(snapshot(5_000, 3));
    recordLaneSamples(snapshot(8_999, 4));
    recordLaneSamples(snapshot(0, 9));
    recordLaneSamples({ ...snapshot(10_000, 0), lanes: [] });
    expect(laneHistory('codex')).toEqual([
      { at: start, busy: 1, slots: 4 }, { at: start + 5_000, busy: 3, slots: 4 },
    ]);
    expect(laneHistory('local')).toEqual([]);
  });

  it('keeps the newest 120 samples and accepts a sample exactly four seconds later', () => {
    for (let i = 0; i < MAX_SAMPLES + 3; i++) recordLaneSamples(snapshot(i * 4_000, i));
    expect(laneHistory('codex')).toHaveLength(MAX_SAMPLES);
    expect(laneHistory('codex')[0]?.busy).toBe(3);
    expect(laneHistory('codex').at(-1)?.busy).toBe(122);
  });

  it('falls back to the supplied clock when the timestamp is invalid', () => {
    recordLaneSamples({ ...snapshot(0, 1), generatedAt: '' }, 123);
    expect(laneHistory('codex')[0]?.at).toBe(123);
  });

  it('summarises only observed samples and describes the observed span', () => {
    recordLaneSamples(snapshot(0, 18));
    expect(summariseLane(laneHistory('codex'), start)).toBeNull();
    recordLaneSamples(snapshot(12 * 60_000, 23));
    const summary = summariseLane(laneHistory('codex'), start + 20 * 60_000)!;
    expect(summary).toEqual({ points: [18, 23], first: 18, last: 23, spanMs: 720_000 });
    expect(describeLane('codex-personal', summary)).toBe('codex-personal: 18 → 23 busy over 12 min');
    expect(describeLane('codex', { ...summary, spanMs: 59_999 })).toBe('codex: 18 → 23 busy over the last minute');
  });

  it('clears all history on reset', () => {
    recordLaneSamples(snapshot(0, 1));
    resetLaneHistory();
    expect(laneHistory('codex')).toEqual([]);
  });
});
