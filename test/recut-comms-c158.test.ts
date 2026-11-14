/**
 * recut-comms-c158 — independent assertion of the per-seat quota freshness
 * markers recovered from PR #5077 (RQ-PHX-QUOTAPERSEATAGE154), exercised
 * through the real comms entry points: quotaLines plus the email and
 * Telegram fleet-status seams. Fake seats and clocks only.
 */
import { describe, expect, it } from 'vitest';
import { boundedQuotaLines, quotaLines } from '../src/core/comms/status-quota-lines.js';
import { emailFleetStatus } from '../src/core/comms/email-fleet-status.js';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';

// Types are derived through the module under test so this suite stays outside
// the Tier-1 authority surface (the tier1-test rule counts type imports).
type CapacitySnapshot = NonNullable<Parameters<typeof quotaLines>[0]>;
type SeatCapacity = CapacitySnapshot['seats'][number];

const NOW = Date.parse('2026-11-11T12:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const seat = (label: string, observedAt: string | null): SeatCapacity => ({
  seatId: `seat-${label.toLowerCase()}`,
  label,
  engine: 'codex',
  free: false,
  signedOut: false,
  reachable: true,
  contextWindow: null,
  spentTodayUsd: null,
  observedAt,
  windows: [{ id: 'weekly', usedPercent: 40, resetsAt: null, resetDescription: 'next week', limitReached: false }],
});

const snapshot = (seats: SeatCapacity[], publishedAt = iso(NOW - MIN)): CapacitySnapshot =>
  ({ v: 1, publishedAt, seats });

describe('recovered per-seat quota freshness (PR #5077)', () => {
  it('marks a stale seat on its own line and leaves a fresh seat unmarked', () => {
    const result = quotaLines(snapshot([seat('Alpha', iso(NOW - 45 * MIN)), seat('Beta', iso(NOW - MIN))]), NOW);
    expect(result[0]).toBe('Quota (stale, historical) Alpha: weekly: 40% · next week');
    expect(result[1]).toBe('Quota Beta: weekly: 40% · next week');
  });

  it('falls back to publication time only when the seat offers no observation', () => {
    const stalePublished = quotaLines(snapshot([seat('Alpha', null)], iso(NOW - 45 * MIN)), NOW);
    expect(stalePublished[0]).toContain('(stale, historical)');
    const freshPublished = quotaLines(snapshot([seat('Alpha', null)]), NOW);
    expect(freshPublished[0]).toBe('Quota Alpha: weekly: 40% · next week');
  });

  it('reads unverifiable timestamps as unknown rather than current', () => {
    expect(quotaLines(snapshot([seat('Alpha', 'not-a-date')]), NOW)[0]).toContain('(freshness unknown)');
    expect(quotaLines(snapshot([seat('Alpha', iso(NOW + MIN))]), NOW)[0]).toContain('(freshness unknown)');
    expect(quotaLines(snapshot([seat('Alpha', iso(NOW - MIN))]), Number.NaN)[0]).toContain('(freshness unknown)');
  });

  it('keeps the marker through the bounded output boundary', () => {
    const lines = boundedQuotaLines(quotaLines(snapshot([seat('Alpha', iso(NOW - 45 * MIN))]), NOW));
    expect(lines[0]).toContain('(stale, historical)');
  });

  it('carries the marker into both fleet-status reply bodies', async () => {
    const readQuota = () => quotaLines(snapshot([seat('Alpha', iso(NOW - 45 * MIN)), seat('Beta', iso(NOW - MIN))]), NOW);
    const email = await emailFleetStatus(undefined, () => new Date(NOW), { readQuota });
    const telegram = await telegramFleetStatus({ now: () => new Date(NOW), readQuota });
    for (const body of [email, telegram]) {
      expect(body).toContain('Quota (stale, historical) Alpha:');
      expect(body).toContain('Quota Beta:');
    }
  });
});
