import { describe, expect, it } from 'vitest';
import { barRows } from './ResourcesBar.js';
import type { CapacityRow } from '../usage/capacity-strip-model.js';

const now = Date.parse('2026-09-25T02:00:00Z');
const row = (patch: Partial<CapacityRow>): CapacityRow => ({
  seatId: 'fake-codex', label: 'Codex', engine: 'codex', monogram: 'C', kind: 'subscription',
  plan: 'pro', cls: 'usable', word: 'usable', summary: '', connection: null,
  windows: [], credits: null, creditBalance: null, creditState: 'unknown', reserve: null, notes: [], localCount: 0,
  checkedAt: null, usageObservedAt: null, connectionCheckedAt: null, resetAt: null, signedOut: false,
  creditObservedAt: null, creditsExpiresAt: null, ...patch,
} as CapacityRow);

describe('Codex credit reasons', () => {
  it('distinguishes unread, stale, and unreported credits while retaining confirmed values', () => {
    const recent = new Date(now - 60_000).toISOString();
    const rows = barRows([
      row({}),
      row({ creditState: 'available', credits: '12 credits available', creditBalance: '12', creditObservedAt: new Date(now - 3 * 60 * 60_000).toISOString() }),
      row({ creditObservedAt: recent }),
      row({ creditState: 'available', credits: '12 credits available', creditBalance: '12', creditObservedAt: recent, creditsExpiresAt: new Date(now + 60_000).toISOString() }),
    ], { healthRead: true, now });
    expect(rows.map(value => value.creditLabel)).toEqual([
      'Credits: no reading yet', 'Credits: last read 3 h ago', 'Credits: not reported by this plan', 'Credits ≈$0.48',
    ]);
    for (const value of rows.slice(0, 3)) {
      expect(value.detail.join(' ')).toContain('Current credit balance is unknown');
      expect(value.exactCreditBalance).toBeUndefined();
    }
    expect(rows[3]!.exactCreditBalance).toBe('12');
  });
});
