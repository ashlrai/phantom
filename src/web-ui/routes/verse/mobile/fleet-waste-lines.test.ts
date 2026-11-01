import { describe, expect, it } from 'vitest';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../usage/fleet-ledger-model.js';
import { wasteLines } from './fleet-waste-lines.js';

const now = Date.parse('2026-10-31T20:00:00Z');
function lane(name: string, usedPct: number): ResourceLaneRow {
  return {
    lane: name, window: 'weekly', usedPct, resetAt: new Date(now + 6 * 3_600_000).toISOString(),
    burnPctPerHour: 0, held: false, running: null, target: null, creditsRemaining: null,
    tokensPerHour6h: null, projectedExhaustion: null, source: 'status',
  };
}
function ledger(lanes: ResourceLaneRow[]): ResourceLedgerV1 {
  return { v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'missing' }, asOf: null, lanes, apiSpend: null };
}

describe('wasteLines', () => {
  it('sorts by projected unused capacity, caps rows, and counts all forecasts in the headline', () => {
    const result = wasteLines(ledger([lane('e', 70), lane('b', 40), lane('a', 10), lane('d', 60), lane('c', 50)]), now);
    expect(result.rows.map((row) => row.lane)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.rows.map((row) => row.tone)).toEqual(['bad', 'bad', 'bad', 'warn']);
    expect(result.headline).toBe('Waste forecast: 270 points unused across 5 lanes');
    expect(result.rows[0]?.text).toContain('90% unused at reset');
  });

  it('limits long forecast text to 90 characters', () => {
    const result = wasteLines(ledger([lane('a'.repeat(100), 10)]), now);
    expect(result.rows[0]?.text).toHaveLength(90);
    expect(result.rows[0]?.text.endsWith('…')).toBe(true);
  });

  it('returns no forecast for missing, non-weekly or incomplete data', () => {
    expect(wasteLines(null, now)).toEqual({ headline: null, rows: [] });
    expect(wasteLines(undefined, now)).toEqual({ headline: null, rows: [] });
    expect(wasteLines(ledger([{ ...lane('credits', 0), window: 'credits' }, { ...lane('unknown', 0), resetAt: null }]), now))
      .toEqual({ headline: null, rows: [] });
  });
});
