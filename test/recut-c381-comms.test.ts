import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuotaLines } from '../src/core/comms/status-quota-lines.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const iso = (ageMs: number) => new Date(NOW - ageMs).toISOString();
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'recut-c381-comms-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function publish(observations: Array<[string, string, number | null]>): void {
  const dir = join(home, '.ashlr', 'routing');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'capacity.json'), JSON.stringify({
    v: 1, publishedAt: iso(60_000),
    seats: observations.map(([label, observedAt, usedPercent]) => ({
      seatId: label.toLowerCase().replaceAll(' ', '-'), label, engine: 'codex', free: false,
      signedOut: false, reachable: true, contextWindow: null,
      spentTodayUsd: null, observedAt,
      windows: [{ id: 'weekly', usedPercent, resetsAt: null,
        resetDescription: 'next week', limitReached: false }],
    })),
  }), { mode: 0o600 });
}

it('reads per-seat freshness at the exact boundary without hiding stale zero or unknown usage', () => {
  publish([
    ['Boundary', iso(30 * 60_000), 42],
    ['Stale Zero', iso(30 * 60_000 + 1), 0],
    ['Stale Unknown', iso(45 * 60_000), null],
  ]);
  expect(readQuotaLines(NOW)).toEqual([
    'Quota Boundary: weekly: 42% · next week',
    'Quota (stale, historical) Stale Zero: weekly: 0% · next week',
    'Quota (stale, historical) Stale Unknown: weekly: unknown · next week',
  ]);
});

it('keeps a future observation unknown beside a fresh seat after reading the published snapshot', () => {
  publish([['Future', iso(-60_000), 42], ['Fresh', iso(60_000), 10]]);
  expect(readQuotaLines(NOW)).toEqual([
    'Quota (freshness unknown) Future: weekly: 42% · next week',
    'Quota Fresh: weekly: 10% · next week',
  ]);
});
