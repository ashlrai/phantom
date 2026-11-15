/**
 * Recut of #5046 (RQ-PHX-QUOTASEATFRESH144) onto master's per-seat freshness.
 *
 * Master (via #5077) already judges each seat on its own timestamp. What
 * #5046 still carried that master lacked: a snapshot with NO seats was never
 * judged at all, so an hours-old empty publication (every seat dropped by
 * validation, or a collector that last saw nothing) read as a current
 * "Quota: no seats reported". These tests drive the real seam end to end: a
 * capacity.json on disk under the relocated test HOME, read by
 * readQuotaLines, then rendered by the email and Telegram status replies.
 *
 * The snapshot is written as raw JSON rather than through
 * src/core/routing/** so this suite stays outside the Tier-1 authority
 * surface (the tier1-test rule counts imports from that tree).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { boundedQuotaLines, quotaLines, readQuotaLines } from '../src/core/comms/status-quota-lines.js';
import { emailFleetStatus } from '../src/core/comms/email-fleet-status.js';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';

type CapacitySnapshot = NonNullable<Parameters<typeof quotaLines>[0]>;
type SeatCapacity = CapacitySnapshot['seats'][number];

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

const seat = (label: string, observedAt: string | null): SeatCapacity => ({
  seatId: label, label, engine: 'codex', free: false, signedOut: false, reachable: true,
  contextWindow: null, spentTodayUsd: null, observedAt,
  windows: [{ id: 'weekly', usedPercent: 42, resetsAt: null, resetDescription: 'next week', limitReached: false }],
});

let savedHome: string | undefined;
let home: string;

beforeEach(() => {
  savedHome = process.env['HOME'];
  // A fresh scratch home inside the suite's already-relocated HOME.
  home = mkdtempSync(join(homedir(), 'quota-seatless-c170-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function publish(raw: unknown): void {
  const dir = join(home, '.ashlr', 'routing');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'capacity.json');
  writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  chmodSync(file, 0o600);
}

describe('seat-less quota snapshots are judged by their publication time', () => {
  it('flags an old empty snapshot read from disk as stale, not current', () => {
    publish({ v: 1, publishedAt: iso(-90), seats: [] });
    expect(readQuotaLines(NOW)).toEqual(['Quota (stale, historical): no seats reported']);
  });

  it('flags an old snapshot whose every seat fails validation as stale', () => {
    // sanitizeSeatCapacity drops these; the reader is left with zero seats.
    publish({ v: 1, publishedAt: iso(-90), seats: [{ nonsense: true }, 'not-a-seat', null] });
    expect(readQuotaLines(NOW)).toEqual(['Quota (stale, historical): no seats reported']);
  });

  it('keeps a recent empty snapshot as the plain no-seats line', () => {
    publish({ v: 1, publishedAt: iso(-1), seats: [] });
    expect(readQuotaLines(NOW)).toEqual(['Quota: no seats reported']);
  });

  it('treats exactly the stale bound as current and one minute past as stale', () => {
    expect(quotaLines({ v: 1, publishedAt: iso(-30), seats: [] }, NOW)).toEqual(['Quota: no seats reported']);
    expect(quotaLines({ v: 1, publishedAt: iso(-31), seats: [] }, NOW))
      .toEqual(['Quota (stale, historical): no seats reported']);
  });

  it('marks an empty snapshot with an untrustworthy stamp or clock as unknown', () => {
    for (const [publishedAt, clock] of [['garbage', NOW], [iso(5), NOW], [iso(-1), Number.NaN]] as const) {
      expect(quotaLines({ v: 1, publishedAt, seats: [] }, clock))
        .toEqual(['Quota (freshness unknown): no seats reported']);
    }
  });

  it('leaves missing snapshots and per-seat lines exactly as master renders them', () => {
    expect(readQuotaLines(NOW)).toEqual(['Quota: unavailable (Phantom desktop not running)']);
    const lines = quotaLines({ v: 1, publishedAt: iso(-90), seats: [seat('Codex', iso(-45)), seat('Devin', iso(-1))] }, NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Quota (stale, historical) Codex: weekly: 42% · next week');
    expect(lines[1]).toBe('Quota Devin: weekly: 42% · next week');
  });

  it('carries the stale marker through the email and Telegram status replies', async () => {
    publish({ v: 1, publishedAt: iso(-90), seats: [] });
    const readQuota = () => readQuotaLines(NOW);
    const email = await emailFleetStatus(undefined, () => new Date(NOW), { readQuota });
    const telegram = await telegramFleetStatus({ now: () => new Date(NOW), readQuota });
    for (const body of [email, telegram]) {
      expect(body).toContain('Quota (stale, historical): no seats reported');
      expect(body).not.toMatch(/^Quota: no seats reported$/m);
    }
    expect(boundedQuotaLines(readQuota())).toEqual(['Quota (stale, historical): no seats reported']);
  });
});
