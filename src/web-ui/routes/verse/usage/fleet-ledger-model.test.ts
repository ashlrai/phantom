import { describe, expect, it } from 'vitest';
import { apiSpendLine, asOfText, isResourceLedger, ledgerRows, type ResourceLaneRow, type ResourceLedgerV1 } from './fleet-ledger-model.js';

export const now = Date.parse('2026-01-01T12:00:00Z');
export const lane = (overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({ lane: 'Codex', running: 8, target: 24, held: false, window: 'weekly', usedPct: 72, creditsRemaining: null, resetAt: new Date(now + 51 * 3_600_000).toISOString(), burnPctPerHour: 1.4, tokensPerHour6h: null, projectedExhaustion: new Date(now + 9 * 3_600_000).toISOString(), source: 'dispatchd at 11:56', ...overrides });
export const fixture: ResourceLedgerV1 = { v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: new Date(now - 4 * 60_000).toISOString(), lanes: [lane(), lane({ lane: 'Claude', held: true, usedPct: 90 }), lane({ lane: 'Credits', window: 'credits', usedPct: null, creditsRemaining: 6000, burnPctPerHour: null, tokensPerHour6h: 469000 }), lane({ lane: 'Local', window: 'none', usedPct: null, running: null, target: null, resetAt: null, projectedExhaustion: null, burnPctPerHour: null })], apiSpend: { rowsToday: 12, errorsToday: 1, tokensOutToday: 48000, tokensInToday: 2000, usdToday: 3.2, usdWeek: 5, lastAt: new Date(now).toISOString(), models: ['fake-model'] } };

describe('fleet ledger model', () => {
  it('projects all lanes, relative times and attribution', () => {
    const rows = ledgerRows(fixture, now);
    expect(rows[0]).toMatchObject({ usage: '72 % of weekly', resets: 'resets in 2 d 3 h', burn: '1.4 %/h', runsOut: 'runs out in 9 h', running: '8/24', source: 'dispatchd at 11:56', tone: 'warn' });
    expect(rows[1]).toMatchObject({ held: true, tone: 'bad', caption: 'Weekly window only. No 5-hour limit.' });
    expect(rows[2]).toMatchObject({ usage: '6 000 credits left', burn: '469 k tok/h' });
    expect(rows[3]).toMatchObject({ usage: 'no cap tracked', resets: null, burn: null, runsOut: null, running: null, tone: 'good' });
    expect(asOfText(fixture, now)).toBe('ledger as of 4 min ago');
    expect(JSON.stringify(rows).replace('Weekly window only. No 5-hour limit.', '')).not.toMatch(/5h|5-hour window/i);
  });
  it('uses threshold boundaries and preserves unknown values', () => {
    const data = { ...fixture, lanes: [lane({ usedPct: 69.9 }), lane({ usedPct: 70 }), lane({ usedPct: 89.9 }), lane({ usedPct: 90 }), lane({ usedPct: null, resetAt: new Date(now - 1).toISOString() }), lane({ window: 'credits', creditsRemaining: null })] };
    const rows = ledgerRows(data, now);
    expect(rows.map(row => row.tone)).toEqual(['good', 'warn', 'warn', 'bad', 'good', 'warn']);
    expect(rows[4]).toMatchObject({ usage: 'weekly usage unknown', resets: 'resets now' });
    expect(rows[5]?.usage).toBe('credits unknown');
    expect(asOfText({ ...fixture, asOf: null }, now)).toBe('ledger as of unknown');
  });
  it('formats gift pool spend with and without a price', () => {
    expect(apiSpendLine(fixture.apiSpend!)).toBe('Gift pool today: 12 runs · 1 error · 48 k tokens out · $3.20');
    expect(apiSpendLine({ ...fixture.apiSpend!, rowsToday: 1, errorsToday: 0, usdToday: null })).toBe('Gift pool today: 1 run · 0 errors · 48 k tokens out');
  });
  it('guards the complete versioned wire shape', () => {
    expect(isResourceLedger(fixture)).toBe(true);
    expect(isResourceLedger({ ...fixture, v: 2 })).toBe(false);
    expect(isResourceLedger({ ...fixture, lanes: [lane({ deadSignal: { lane: 'Codex', lastFinishes: 8, emptyFailures: 9, state: 'dead' } })] })).toBe(false);
    expect(isResourceLedger({ ...fixture, lanes: [{ ...fixture.lanes[0], usedPct: '72' }] })).toBe(false);
    expect(isResourceLedger({ ...fixture, apiSpend: { ...fixture.apiSpend, models: [5] } })).toBe(false);
  });
});
