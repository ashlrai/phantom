/**
 * status-quota-seat-freshness-144 — per-seat freshness in quotaLines.
 * A just-observed seat must never hide a stale neighbour; seats with no
 * usable timestamp are qualified as unknown rather than passed off as
 * current. Recovered from #5046 onto master’s stricter timestamp contract:
 * invalid observations stay unknown; stale markers precede bounded labels.
 * Pure fixtures at a fixed clock; quotaLines itself is exercised.
 */
import { describe, expect, it } from 'vitest';
import { quotaLines } from '../src/core/comms/status-quota-lines.js';
// Derive fixture types through the public COMMS entry point.
type CapacitySnapshot = NonNullable<Parameters<typeof quotaLines>[0]>;
type SeatCapacity = CapacitySnapshot['seats'][number];

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const STALE_AFTER_MS = 30 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

function seat(overrides: Partial<SeatCapacity>): SeatCapacity {
  return {
    seatId: 'seat-1',
    engine: 'codex',
    label: 'Seat One',
    free: false,
    windows: [],
    signedOut: false,
    reachable: true,
    contextWindow: null,
    observedAt: iso(NOW - MIN),
    spentTodayUsd: null,
    ...overrides,
  };
}

const snapshot = (seats: SeatCapacity[], publishedAt = iso(NOW - MIN)): CapacitySnapshot =>
  ({ v: 1, publishedAt, seats });

describe('quotaLines per-seat freshness', () => {
  it('qualifies a stale seat on its own line in both seat orders', () => {
    const fresh = seat({ seatId: 'claude', engine: 'claude', label: 'Claude Fresh' });
    const stale = seat({
      seatId: 'codex-personal', engine: 'codex', label: 'Codex Stale',
      observedAt: iso(NOW - 45 * MIN),
      windows: [{ id: 'codex_primary', usedPercent: 62, resetsAt: iso(NOW + 2 * HOUR), resetDescription: null, limitReached: false }],
    });
    for (const seats of [[fresh, stale], [stale, fresh]]) {
      const lines = quotaLines(snapshot(seats), NOW);
      expect(lines).toHaveLength(2);
      const staleLine = lines.find((line) => line.includes('Codex Stale'))!;
      const freshLine = lines.find((line) => line.includes('Claude Fresh'))!;
      expect(staleLine).toContain('(stale, historical)');
      expect(staleLine).toContain('codex_primary: 62%');
      expect(freshLine).not.toContain('stale');
      expect(freshLine).not.toContain('freshness unknown');
      // No single global banner may speak for mixed ages.
      expect(lines.some((line) => line === 'Quota (stale, read 45m ago):')).toBe(false);
    }
  });

  it('keeps invalid observations unknown and falls back only for absent observations', () => {
    const viaFreshPublish = seat({ observedAt: 'not-a-date', label: 'Fallback Fresh' });
    const freshLines = quotaLines(snapshot([viaFreshPublish], iso(NOW - 5 * MIN)), NOW);
    expect(freshLines).toEqual(['Quota (freshness unknown) Fallback Fresh: no windows reported']);
    expect(quotaLines(snapshot([seat({ observedAt: null, label: 'Absent' })]), NOW))
      .toEqual(['Quota Absent: no windows reported']);

    const viaStalePublish = seat({ observedAt: null, label: 'Fallback Stale' });
    const staleLines = quotaLines(snapshot([viaStalePublish], iso(NOW - 45 * MIN)), NOW);
    expect(staleLines).toEqual(['Quota (stale, historical) Fallback Stale: no windows reported']);
  });

  it('marks freshness unknown when neither timestamp parses', () => {
    const lines = quotaLines(snapshot(
      [seat({ observedAt: 'garbage', label: 'Mystery Seat' })],
      'also-garbage',
    ), NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('Quota (freshness unknown) Mystery Seat: no windows reported');
  });

  it('treats exactly the stale bound as fresh and one millisecond past as stale', () => {
    const atBound = quotaLines(snapshot([seat({ observedAt: iso(NOW - STALE_AFTER_MS) })]), NOW);
    expect(atBound[0]).not.toContain('stale');
    expect(atBound[0]).not.toContain('freshness unknown');

    const pastBound = quotaLines(snapshot([seat({ observedAt: iso(NOW - STALE_AFTER_MS - 1) })]), NOW);
    expect(pastBound).toEqual(['Quota (stale, historical) Seat One: no windows reported']);
  });

  it('qualifies every stale seat independently without an extra global banner', () => {
    const lines = quotaLines(snapshot([
      seat({ seatId: 'a', label: 'Seat A', observedAt: iso(NOW - 40 * MIN) }),
      seat({ seatId: 'b', label: 'Seat B', observedAt: iso(NOW - 90 * MIN) }),
    ]), NOW);
    expect(lines).toEqual([
      'Quota (stale, historical) Seat A: no windows reported',
      'Quota (stale, historical) Seat B: no windows reported',
    ]);
  });

  it('scrubs sensitive labels and keeps qualified lines bounded', () => {
    const secret = `ghp_${'c'.repeat(36)}`;
    const lines = quotaLines(snapshot([
      seat({
        label: `Stale ${secret} ${'x.'.repeat(80)}`,
        observedAt: iso(NOW - 45 * MIN),
        windows: [{ id: 'codex_primary', usedPercent: 1, resetsAt: null, resetDescription: `rotates ${secret}`, limitReached: false }],
      }),
      seat({ label: 'Fresh Seat', windows: [{ id: 'codex_primary', usedPercent: 2, resetsAt: null, resetDescription: null, limitReached: false }] }),
    ]), NOW);
    for (const line of lines) {
      expect(line).not.toContain(secret);
      expect(line.length).toBeLessThanOrEqual(160);
    }
    expect(lines.some((line) => line.includes('[REDACTED]'))).toBe(true);
  });

  it('keeps genuine zero usage distinct from unknown usage on a stale seat', () => {
    const lines = quotaLines(snapshot([seat({
      observedAt: iso(NOW - 45 * MIN),
      windows: [
        { id: 'codex_zero', usedPercent: 0, resetsAt: iso(NOW + HOUR), resetDescription: null, limitReached: false },
        { id: 'codex_unknown', usedPercent: null, resetsAt: null, resetDescription: null, limitReached: false },
      ],
    })]), NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Quota (stale, historical) Seat One:');
    expect(lines[0]).toContain('codex_zero: 0%');
    expect(lines[0]).toContain('codex_unknown: unknown');
  });
});
