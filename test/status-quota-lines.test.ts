/**
 * status-quota-lines — the provider-quota projection appended to the Telegram
 * and email /fleet-status replies. Pure fixtures at a fixed clock; the only
 * filesystem touch is a fake capacity snapshot inside a relocated HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedQuotaLines, quotaLines, readQuotaLines } from '../src/core/comms/status-quota-lines.js';
import { emailFleetStatus } from '../src/core/comms/email-fleet-status.js';
import { telegramFleetStatus } from '../src/core/comms/telegram-fleet-status.js';
import { writeCapacitySnapshot, type CapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
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

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'status-quota-home-'));
  process.env['HOME'] = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('quotaLines', () => {
  it('renders Codex countdowns and keeps only Claude weekly windows with their prose reset', () => {
    const codex = seat({
      seatId: 'codex-personal', label: 'Codex Personal', engine: 'codex',
      windows: [
        { id: 'codex_personal_primary', usedPercent: 12, resetsAt: iso(NOW + 2 * HOUR), resetDescription: null, limitReached: false },
        { id: 'codex_personal_secondary', usedPercent: 62, resetsAt: iso(NOW + 2 * DAY + 3 * HOUR), resetDescription: null, limitReached: false },
      ],
    });
    const claude = seat({
      seatId: 'claude', label: 'Claude', engine: 'claude',
      windows: [
        { id: 'five_hour', usedPercent: 90, resetsAt: iso(NOW + 2 * HOUR), resetDescription: null, limitReached: false },
        { id: 'seven_day', usedPercent: 40, resetsAt: null, resetDescription: 'Resets Thursday at 3pm', limitReached: false },
      ],
    });
    const lines = quotaLines(snapshot([codex, claude]), NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Quota Codex Personal: codex_personal_primary: 12% · resets in 2h; codex_personal_secondary: 62% · resets in 2d 3h');
    expect(lines[0]).toContain('62% · resets in 2d 3h');
    expect(lines[1]).toBe('Quota Claude: seven_day: 40% · Resets Thursday at 3pm');
    expect(lines[1]).not.toContain('five_hour');
    expect(lines[1]).not.toContain('90%');
  });

  it('reads unavailable when there is no snapshot at all', () => {
    expect(quotaLines(null, NOW)).toEqual(['Quota: unavailable (Phantom desktop not running)']);
  });

  it('flags a snapshot older than 30 minutes instead of passing it off as current', () => {
    const stale = quotaLines(snapshot([seat({ observedAt: iso(NOW - 45 * MIN) })], iso(NOW - 45 * MIN)), NOW);
    expect(stale[0]).toBe('Quota (stale, read 45m ago):');
    // A fresh seat reading is current even when the file itself was written earlier.
    const fresh = quotaLines(snapshot([seat({})], iso(NOW - 45 * MIN)), NOW);
    expect(fresh[0]).not.toContain('stale');
  });

  it('renders a null usedPercent as unknown, never zero', () => {
    const lines = quotaLines(snapshot([seat({
      windows: [{ id: 'codex_primary', usedPercent: null, resetsAt: iso(NOW + 5 * HOUR), resetDescription: null, limitReached: false }],
    })]), NOW);
    expect(lines[0]).toContain('codex_primary: unknown · resets in 5h');
    expect(lines[0]).not.toContain('0%');
  });

  it('reports a reset in the past as passed and marks a flagged limit', () => {
    const lines = quotaLines(snapshot([seat({
      windows: [
        { id: 'codex_primary', usedPercent: 100, resetsAt: iso(NOW - HOUR), resetDescription: null, limitReached: false },
        { id: 'codex_secondary', usedPercent: 99, resetsAt: iso(NOW + DAY), resetDescription: null, limitReached: true },
      ],
    })]), NOW);
    expect(lines[0]).toContain('codex_primary: 100% · reset passed');
    expect(lines[0]).toContain('codex_secondary: 99% · resets in 24h (limit reached)');
  });

  it('falls back to reset unknown when neither a machine reset nor prose is offered', () => {
    const lines = quotaLines(snapshot([seat({
      engine: 'claude', label: 'Claude',
      windows: [{ id: 'seven_day', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false }],
    })]), NOW);
    expect(lines[0]).toContain('seven_day: 5% · reset unknown');
  });

  it('scrubs a secret-shaped resetDescription and bounds every line', () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const lines = quotaLines(snapshot([seat({
      label: `Label ${'x.'.repeat(80)}`,
      windows: [{ id: 'codex_primary', usedPercent: 1, resetsAt: null, resetDescription: `resets when ${secret} rotates ${'y.'.repeat(60)}`, limitReached: false }],
    })]), NOW);
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[0]!.length).toBeLessThanOrEqual(160);
  });

  it('caps the roster at eight seats', () => {
    const seats = Array.from({ length: 10 }, (_, index) => seat({ seatId: `seat-${index}`, label: `Seat ${index}` }));
    expect(quotaLines(snapshot(seats), NOW)).toHaveLength(8);
  });
});

describe('readQuotaLines', () => {
  it('reports the desktop as not running when no snapshot file exists', () => {
    expect(readQuotaLines(NOW)).toEqual(['Quota: unavailable (Phantom desktop not running)']);
  });

  it('renders the published snapshot from ~/.ashlr/routing/capacity.json', () => {
    writeCapacitySnapshot([seat({
      seatId: 'codex-personal', label: 'Codex Personal',
      windows: [{ id: 'codex_personal_secondary', usedPercent: 62, resetsAt: iso(NOW + 2 * DAY + 3 * HOUR), resetDescription: null, limitReached: false }],
    })], new Date(NOW - MIN));
    const lines = readQuotaLines(NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Codex Personal');
    expect(lines[0]).toContain('62% · resets in 2d 3h');
  });
});

describe('boundedQuotaLines', () => {
  it('projects injected reader output onto short scrubbed strings', () => {
    const secret = `ghp_${'b'.repeat(36)}`;
    const long = `Quota Y: ${'z.'.repeat(100)}`;
    const bounded = boundedQuotaLines([`Quota X: 1% · ${secret}`, 42, long]);
    expect(bounded[0]).toBe('Quota X: 1% · [REDACTED]');
    expect(bounded[1]).toBe(long.slice(0, 160));
    expect(boundedQuotaLines('nope')).toEqual(['Quota: unavailable']);
    expect(boundedQuotaLines([])).toEqual(['Quota: unavailable']);
  });
});

describe('status replies', () => {
  it('telegramFleetStatus appends the quota lines after the lane rows, before supply', async () => {
    const body = await telegramFleetStatus({
      now: () => new Date(NOW),
      readQuota: () => ['Quota Codex Personal: codex_personal_secondary: 62% · resets in 2d 3h'],
    });
    expect(body).toContain('Quota Codex Personal: codex_personal_secondary: 62% · resets in 2d 3h');
    expect(body).toContain('quota lines come from provider windows');
    const lines = body.split('\n');
    const usage = lines.findIndex((line) => line.startsWith('Usage:'));
    const quota = lines.findIndex((line) => line.startsWith('Quota '));
    const supply = lines.findIndex((line) => line.startsWith('Supply:'));
    expect(quota).toBeGreaterThan(usage);
    expect(quota).toBeLessThan(supply);
  });

  it('telegramFleetStatus contains a failing quota reader', async () => {
    const body = await telegramFleetStatus({
      now: () => new Date(NOW),
      readQuota: () => { throw new Error('private quota path'); },
    });
    expect(body).toContain('Quota: unavailable');
    expect(body).not.toContain('private quota path');
  });

  it('emailFleetStatus pushes the quota lines before the supply lines', async () => {
    const body = await emailFleetStatus(undefined, () => new Date(NOW), {
      readQuota: () => ['Quota Claude: seven_day: 40% · Resets Thursday at 3pm'],
    });
    expect(body).toContain('Quota Claude: seven_day: 40% · Resets Thursday at 3pm');
    const lines = body.split('\n');
    const quota = lines.findIndex((line) => line.startsWith('Quota '));
    const supply = lines.findIndex((line) => line.startsWith('Supply:'));
    expect(quota).toBeGreaterThan(-1);
    expect(quota).toBeLessThan(supply);
  });
});
