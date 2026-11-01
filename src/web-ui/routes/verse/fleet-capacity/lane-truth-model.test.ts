import { describe, expect, it } from 'vitest';
import { truthHeadline, verdictText, verdictTone } from './lane-truth-model.js';
import type { LaneTruthLane, LaneTruthMeter } from './lane-truth-queries.js';

const meter = (over: Partial<LaneTruthMeter> = {}): LaneTruthMeter => ({
  provider: 'codex-personal', usedPercent: 1, resetAt: '2026-11-07T12:00:00.000Z', sampledAt: '2026-10-31T12:00:00.000Z', ...over,
});
const row = (over: Partial<LaneTruthLane>): LaneTruthLane => ({
  lane: 'codex-personal', verdict: 'ok', target: 10, running: 1, queued: 0, held: false, meter: null, reason: '', ...over,
});

describe('verdictText', () => {
  it('words a held lane with its meter reading and reset', () => {
    expect(verdictText(row({ verdict: 'held_with_capacity', held: true, running: 0, queued: 16, meter: meter() })))
      .toBe('Held with capacity: codex-personal is held while its meter shows 1% used (resets Nov 7).');
  });
  it('still words a held lane when the meter reading is partial', () => {
    expect(verdictText(row({ verdict: 'held_with_capacity', held: true, meter: meter({ usedPercent: null }) })))
      .toBe('Held with capacity: codex-personal is held while its meter has room.');
    expect(verdictText(row({ verdict: 'held_with_capacity', held: true, meter: null })))
      .toBe('Held with capacity: codex-personal is held while its meter has room.');
  });
  it('words a reset with the newest meter reading', () => {
    expect(verdictText(row({ verdict: 'reset_detected', meter: meter({ usedPercent: 3 }) })))
      .toBe("Reset detected: codex-personal's meter dropped or its reset moved later. Meter now shows 3% used (resets Nov 7).");
    expect(verdictText(row({ verdict: 'reset_detected', meter: null })))
      .toBe("Reset detected: codex-personal's meter dropped or its reset moved later.");
  });
  it('words idle work from the lane counts', () => {
    expect(verdictText(row({ verdict: 'idle_with_work', running: 0, target: 10, queued: 16 })))
      .toBe('Idle with work: 0 of 10 running, 16 queued.');
  });
  it('renders nothing for ok and a fixed explanation for unknown', () => {
    expect(verdictText(row({ verdict: 'ok' }))).toBeNull();
    expect(verdictText(row({ verdict: 'unknown' })))
      .toBe('Lane truth unknown: slots.json or the meter is older than 15 min.');
  });
});

describe('verdictTone', () => {
  it('is bad for waste, warn for a reset, neutral otherwise', () => {
    expect(verdictTone('held_with_capacity')).toBe('bad');
    expect(verdictTone('idle_with_work')).toBe('bad');
    expect(verdictTone('reset_detected')).toBe('warn');
    expect(verdictTone('unknown')).toBeNull();
    expect(verdictTone('ok')).toBeNull();
  });
});

describe('truthHeadline', () => {
  it('is null when nothing needs attention', () => {
    expect(truthHeadline([])).toBeNull();
    expect(truthHeadline([row({ verdict: 'ok' }), row({ lane: 'devin', verdict: 'ok' })])).toBeNull();
  });
  it('names each flagged lane with its verdict', () => {
    expect(truthHeadline([
      row({ verdict: 'held_with_capacity', held: true }),
      row({ lane: 'devin', verdict: 'idle_with_work' }),
      row({ lane: 'alpha', verdict: 'ok' }),
    ])).toBe('2 lanes need attention: codex-personal held with capacity, devin idle with work.');
    expect(truthHeadline([row({ verdict: 'reset_detected' })])).toBe('1 lane needs attention: codex-personal reset detected.');
  });
});
