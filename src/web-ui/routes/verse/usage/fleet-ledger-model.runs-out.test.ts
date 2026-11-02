import { describe, expect, it } from 'vitest';
import { runsOutText, type ResourceLaneRow } from './fleet-ledger-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const lane = (overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: 'codex-personal', running: null, target: null, held: false, window: 'weekly',
  usedPct: 70, creditsRemaining: null, resetAt: null, burnPctPerHour: 4.1,
  tokensPerHour6h: null, projectedExhaustion: null, source: null, ...overrides,
});
const projection = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

describe('runsOutText', () => {
  it('formats a future projection in Eastern time with hours and burn', () => {
    expect(runsOutText(lane({ projectedExhaustion: projection(192) }), now)).toBe('runs out ~11:12 ET (3.2 h) · 4.1 %/h');
  });
  it('uses minutes under an hour', () => {
    expect(runsOutText(lane({ projectedExhaustion: projection(40) }), now)).toBe('runs out ~08:40 ET (in 40 m) · 4.1 %/h');
  });
  it('shows an exhausted lane and its reset, including a past projection', () => {
    const resetAt = '2026-11-02T16:30:00Z';
    expect(runsOutText(lane({ usedPct: 100, resetAt }), now)).toBe('out · resets Mon 11:30 ET · 4.1 %/h');
    expect(runsOutText(lane({ projectedExhaustion: projection(-1), resetAt, burnPctPerHour: null }), now)).toBe('out · resets Mon 11:30 ET');
  });
  it('omits uncapped lanes and missing or non-finite readings', () => {
    expect(runsOutText(lane({ window: 'none', projectedExhaustion: projection(40) }), now)).toBeNull();
    expect(runsOutText(lane({ burnPctPerHour: null }), now)).toBeNull();
    expect(runsOutText(lane({ burnPctPerHour: Infinity }), now)).toBeNull();
    expect(runsOutText(lane({ burnPctPerHour: NaN, projectedExhaustion: projection(40) }), now)).toBe('runs out ~08:40 ET (in 40 m)');
    expect(runsOutText(lane(), now)).toBe('4.1 %/h');
  });
});
