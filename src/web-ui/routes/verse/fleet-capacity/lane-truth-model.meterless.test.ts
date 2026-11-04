import { describe, expect, it } from 'vitest';
import { meterlessIdle, truthHeadline, verdictText } from './lane-truth-model.js';
import type { LaneTruthLane, LaneTruthMeter } from './lane-truth-queries.js';

const staleMeter: LaneTruthMeter = {
  provider: 'codex-personal', usedPercent: 1, resetAt: null, sampledAt: '2026-10-30T00:00:00.000Z',
};
const row = (over: Partial<LaneTruthLane> = {}): LaneTruthLane => ({
  lane: 'cursor', verdict: 'unknown', target: 3, running: 0, queued: 19, held: false, meter: null, reason: '', ...over,
});
const unknownText = 'Lane truth unknown: slots.json or the meter is older than 15 min.';

describe('meterless lane truth', () => {
  it('identifies and describes an unheld idle lane with queued work', () => {
    expect(meterlessIdle(row())).toBe(true);
    expect(verdictText(row())).toBe('No usage meter for cursor; nothing running with 19 queued.');
    expect(truthHeadline([row()])).toBe('1 lane needs attention: cursor idle (no meter).');
  });

  it('describes known counts and excludes other meterless unknown lanes from the headline', () => {
    const others = [
      row({ lane: 'devin', running: 8, target: 10 }),
      row({ held: true }), row({ held: null }), row({ queued: 0 }), row({ queued: null }), row({ target: 0 }),
    ];
    expect(others.every((lane) => !meterlessIdle(lane))).toBe(true);
    expect(verdictText(others[0])).toBe('No usage meter for devin; 8 of 10 running, 19 queued.');
    expect(verdictText(others[4])).toBe('No usage meter for cursor; 0 of 3 running, 0 queued.');
    expect(truthHeadline(others)).toBeNull();
  });

  it('retains the fixed explanation when counts are unknown or a meter exists', () => {
    for (const lane of [row({ running: null }), row({ target: null }), row({ meter: staleMeter })]) {
      expect(meterlessIdle(lane)).toBe(false);
      expect(verdictText(lane)).toBe(unknownText);
    }
    expect(truthHeadline([row({ running: null }), row({ target: null })])).toBeNull();
    expect(truthHeadline([row({ meter: staleMeter })])).toBe('1 lane needs attention: cursor truth unknown.');
  });

  it('keeps actionable and stale-meter rows in input order', () => {
    expect(truthHeadline([
      row({ lane: 'codex-personal', verdict: 'held_with_capacity', held: true, meter: staleMeter }),
      row(),
      row({ lane: 'devin', running: 8, target: 10 }),
      row({ lane: 'codex-personal', meter: staleMeter }),
    ])).toBe('3 lanes need attention: codex-personal held with capacity, cursor idle (no meter), codex-personal truth unknown.');
  });
});
