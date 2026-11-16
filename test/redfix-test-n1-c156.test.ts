import { describe, expect, it } from 'vitest';
import { boundedQuotaLines, quotaLines } from '../src/core/comms/status-quota-lines.js';

// Snapshot types are derived through the module under test so this suite stays
// outside the Tier-1 authority surface (the tier1-test rule counts type-only
// imports from src/core/routing/**).
type CapacitySnapshot = NonNullable<Parameters<typeof quotaLines>[0]>;
type SeatCapacity = CapacitySnapshot['seats'][number];

const now = Date.parse('2026-11-11T12:00:00Z');
const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString();
const seat = (label: string, observedAt: string | null): SeatCapacity => ({
  seatId: label, label, engine: 'codex', free: false, signedOut: false, reachable: true,
  contextWindow: null, spentTodayUsd: null, observedAt,
  windows: [{ id: 'weekly', usedPercent: 42, resetsAt: null, resetDescription: 'next week', limitReached: false }],
});
const snapshot = (seats: SeatCapacity[], publishedAt = iso(-1)): CapacitySnapshot => ({ v: 1, publishedAt, seats });

describe('quotaLines per-seat freshness (Fix of #5077)', () => {
  it('marks a stale seat without letting one fresh observation freshen it', () => {
    const lines = quotaLines(snapshot([seat('Codex', iso(-45)), seat('Devin', iso(-1))]), now);
    // Regression: the old snapshotAgeMs took the freshest timestamp across all
    // seats, so Devin's minute-old read hid that Codex's was 45 minutes stale.
    expect(lines.find((line) => line.includes('Codex'))).toContain('(stale, historical)');
    expect(lines.find((line) => line.includes('Devin'))).not.toContain('stale');
    expect(lines.every((line) => line.startsWith('Quota'))).toBe(true);
  });

  it('flags unknown freshness instead of guessing for invalid, future or clock-less stamps', () => {
    for (const [observed, published, clock] of [
      ['invalid', iso(-1), now],
      [iso(1), iso(-1), now],
      [null, 'invalid', now],
      [iso(-1), iso(-1), NaN],
    ] as const) {
      const [line] = quotaLines(snapshot([seat('A', observed)], published), clock);
      expect(line).toContain('(freshness unknown)');
      expect(line).not.toContain('(stale, historical)');
    }
  });

  it('keeps the marker inside the bounded line the reply formatters emit', () => {
    const lines = boundedQuotaLines(quotaLines(snapshot([seat('Codex', iso(-45))]), now));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Quota (stale, historical) Codex:');
    expect(lines[0]!.length).toBeLessThanOrEqual(160);
  });

  it('still reads missing or seat-less snapshots as unavailable, never zero', () => {
    expect(quotaLines(null, now)).toEqual(['Quota: unavailable (Phantom desktop not running)']);
    expect(quotaLines(snapshot([]), now)).toEqual(['Quota: no seats reported']);
  });
});
