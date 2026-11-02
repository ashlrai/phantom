import { describe, expect, it } from 'vitest';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../usage/fleet-ledger-model.js';
import { exhaustionByLane, soonestExhaustion } from './supply-exhaustion-model.js';

const now = new Date(2026, 10, 4, 7, 30).getTime();
const iso = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const lane = (overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: 'personal', running: 24, target: 24, held: false, window: 'weekly', usedPct: 77,
  creditsRemaining: null, resetAt: iso(48), burnPctPerHour: 5, tokensPerHour6h: null,
  projectedExhaustion: iso(4), source: null, ...overrides,
});
const ledger = (lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: iso(0), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: iso(0), lanes, apiSpend: null,
});

describe('supply exhaustion', () => {
  it('formats future projections and assigns time-based tones at the boundaries', () => {
    const map = exhaustionByLane(ledger([lane(), lane({ lane: 'urgent', projectedExhaustion: iso(1) }), lane({ lane: 'two', projectedExhaustion: iso(2) }), lane({ lane: 'eight', projectedExhaustion: iso(8) })]), now);
    expect(map.get('personal')).toMatchObject({ text: expect.stringMatching(/^runs out ≈ 11:30 .* \(in 4 h\)$/), tone: 'warn', atMs: now + 4 * 3_600_000 });
    expect(map.get('urgent')?.tone).toBe('bad');
    expect(map.get('two')?.tone).toBe('warn');
    expect(map.get('eight')?.tone).toBe('ok');
    expect(soonestExhaustion(map)).toBe('urgent runs out in 1 h');
  });
  it('reports exhaustion and reset before any projection, and formats credits', () => {
    const resetAt = new Date(2026, 10, 4, 1, 41).toISOString();
    const map = exhaustionByLane(ledger([lane({ usedPct: 100, resetAt }), lane({ lane: 'held', held: true, resetAt }), lane({ lane: 'credit', window: 'credits', creditsRemaining: 1250.5, projectedExhaustion: null })]), now);
    expect(map.get('personal')).toMatchObject({ text: expect.stringMatching(/^out of usage · resets Nov 4 01:41/), tone: 'bad', atMs: null });
    expect(map.get('held')?.text).toMatch(/^out of usage · resets Nov 4 01:41/);
    expect(map.get('credit')?.text).toBe('credits: 1,250.5 left');
    expect(soonestExhaustion(map)).toBeNull();
  });
  it('omits unknown, uncapped and past projections and includes the date for a later day', () => {
    const map = exhaustionByLane(ledger([lane({ lane: 'none', window: 'none' }), lane({ lane: 'unknown', projectedExhaustion: null }), lane({ lane: 'credit unknown', window: 'credits', creditsRemaining: null }), lane({ lane: 'past', projectedExhaustion: iso(-1) }), lane({ lane: 'tomorrow', projectedExhaustion: iso(24) })]), now);
    expect([...map.keys()]).toEqual(['tomorrow']);
    expect(map.get('tomorrow')?.text).toMatch(/^runs out ≈ Nov 5 07:30/);
    expect(exhaustionByLane(null, now).size).toBe(0);
  });
});
