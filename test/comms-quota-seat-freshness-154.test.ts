import { describe, expect, it } from 'vitest';
import { boundedQuotaLines, quotaLines } from '../src/core/comms/status-quota-lines.js';
import { emailFleetStatus } from '../src/core/comms/email-fleet-status.js';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';
import type { CapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const now = Date.parse('2026-11-11T12:00:00Z');
const iso = (offset: number) => new Date(now + offset * 60_000).toISOString();
const seat = (label: string, observedAt: string | null, overrides: Partial<SeatCapacity> = {}): SeatCapacity => ({
  seatId: label, label, engine: 'codex', free: false, signedOut: false, reachable: true,
  contextWindow: null, spentTodayUsd: null, observedAt,
  windows: [{ id: 'weekly', usedPercent: 42, resetsAt: null, resetDescription: 'next week', limitReached: false }],
  ...overrides,
});
const lines = (seats: SeatCapacity[], publishedAt = iso(-1), clock = now) =>
  boundedQuotaLines(quotaLines({ v: 1, publishedAt, seats } satisfies CapacitySnapshot, clock));

describe('per-seat quota freshness', () => {
  it.each([false, true])('keeps stale Codex marked beside fresh Devin, reverse=%s', (reverse) => {
    const seats = [seat('Codex', iso(-45)), seat('Devin', iso(-1))];
    const result = lines(reverse ? seats.reverse() : seats);
    expect(result.find(line => line.includes('Codex'))).toContain('(stale, historical)');
    expect(result.find(line => line.includes('Devin'))).not.toContain('stale');
  });

  it('marks every stale seat and uses publication only for absent observations', () => {
    expect(lines([seat('A', iso(-45)), seat('B', iso(-60))]).every(line => line.includes('stale'))).toBe(true);
    expect(lines([seat('A', null)], iso(-45))[0]).toContain('stale');
    expect(lines([seat('A', null)], iso(-1))[0]).not.toContain('stale');
  });

  it.each([
    ['invalid observation', 'invalid', iso(-1), now],
    ['future observation', iso(1), iso(-1), now],
    ['invalid publication', null, 'invalid', now],
    ['invalid clock', iso(-1), iso(-1), NaN],
  ])('marks %s as unknown', (_name, observed, published, clock) => {
    expect(lines([seat('A', observed)], published, clock)[0]).toContain('(freshness unknown)');
  });

  it('retains freshness through truncation, null values, and Claude window filtering', () => {
    const long = seat('Long'.repeat(50), iso(-50), { windows: [{ id: 'window'.repeat(50), usedPercent: null,
      resetsAt: null, resetDescription: 'later'.repeat(50), limitReached: false }] });
    const claude = seat('Claude', iso(-50), { engine: 'claude', windows: [
      { id: 'session', usedPercent: 90, resetsAt: null, resetDescription: null, limitReached: false },
      { id: 'five_hour', usedPercent: 80, resetsAt: null, resetDescription: null, limitReached: false },
      { id: 'seven_day', usedPercent: null, resetsAt: null, resetDescription: 'Thursday', limitReached: true },
    ] });
    const result = lines([long, claude]);
    expect(result[0]).toContain('(stale, historical)');
    expect(result[0]!.length).toBeLessThanOrEqual(160);
    expect(result[1]).toContain('seven_day: unknown · Thursday (limit reached)');
    expect(result[1]).not.toMatch(/session|five_hour/);
  });

  it('preserves the seat indication in email and Telegram replies', async () => {
    const readQuota = () => quotaLines({ v: 1, publishedAt: iso(-1), seats: [seat('Codex', iso(-45)), seat('Devin', iso(-1))] }, now);
    const email = await emailFleetStatus(undefined, () => new Date(now), { readQuota });
    const telegram = await telegramFleetStatus({ now: () => new Date(now), readQuota });
    for (const body of [email, telegram]) expect(body).toContain('Quota (stale, historical) Codex:');
  });
});
