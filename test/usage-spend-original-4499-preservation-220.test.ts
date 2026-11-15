// RQ-PHX-SPENDPRESERVE220S: file-level regression for the spend-down read path
// preserved from PR #4499 (RQ-USAGESPENDN9RQ8, head
// 756e55b290e6e8b834b0c724a9ac434a232b430d). Exercises the public readUsageSpend
// API against a temporary dispatchd status file: a fresh measured 100% reading
// stays a known 100% (no reserve), a passed reset and a stale tick read unknown,
// and malformed or missing files degrade to unknown rows without throwing.
// See BRIDGE_NOTES.md for the per-hunk preservation map.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readUsageSpend } from '../src/core/usage/spend.js';

const NOW = Date.parse('2026-11-12T16:00:00Z');
const HOUR_MS = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const dirs: string[] = [];
async function statusFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usage-spend-220-'));
  dirs.push(dir);
  const path = join(dir, 'status.json');
  await writeFile(path, contents);
  return path;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function status(budget: Record<string, unknown>, lastTick = iso(NOW)): string {
  return JSON.stringify({ schema: 'dispatchd.status.v1', last_tick: lastTick, budget });
}
function measured(usedPct: number, resetAt: string, burn: number, stale = false) {
  return { use_it_all: { known: true, stale, used_pct: usedPct, reset_at: resetAt, burn_pct_per_hour: burn } };
}
const unknownRow = { usedPercent: null, resetAt: null, hoursLeft: null, burnPerHour: null, projectedUnusedPercent: null };

describe('readUsageSpend original preservation', () => {
  it('keeps a fresh measured 100% reading as a known 100% with zero unused projected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const path = await statusFile(status({ 'codex-personal': measured(100, iso(NOW + 10 * HOUR_MS), 0) }));
    const spend = await readUsageSpend(path);
    expect(spend).toMatchObject({ v: 1, asOf: iso(NOW) });
    expect(spend.pools.find(row => row.pool === 'codex-personal')).toEqual({
      pool: 'codex-personal', reason: null, usedPercent: 100, resetAt: iso(NOW + 10 * HOUR_MS),
      hoursLeft: 10, burnPerHour: 0, projectedUnusedPercent: 0,
    });
    expect(spend.pools.filter(row => row.pool !== 'codex-personal')
      .every(row => row.reason !== null && row.usedPercent === null)).toBe(true);
  });

  it('reports the measured unused-at-reset forecast and reads a passed reset or stale flag as unknown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const path = await statusFile(status({
      claude: measured(20, iso(NOW + 10 * HOUR_MS), 3),
      gemini: measured(40, iso(NOW - HOUR_MS), 2),
      zai: { use_it_all: { known: true, stale: true } },
    }));
    const spend = await readUsageSpend(path);
    expect(spend.pools.find(row => row.pool === 'claude')).toEqual({
      pool: 'claude', reason: null, usedPercent: 20, resetAt: iso(NOW + 10 * HOUR_MS),
      hoursLeft: 10, burnPerHour: 3, projectedUnusedPercent: 50,
    });
    expect(spend.pools.find(row => row.pool === 'gemini'))
      .toMatchObject({ reason: 'reading incomplete or reset passed', ...unknownRow });
    expect(spend.pools.find(row => row.pool === 'zai'))
      .toMatchObject({ reason: 'reading stale', ...unknownRow });
  });

  it('marks every pool unknown when the status tick is older than the freshness window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const path = await statusFile(status(
      { claude: measured(20, iso(NOW + 10 * HOUR_MS), 3) },
      iso(NOW - 121_000),
    ));
    const spend = await readUsageSpend(path);
    expect(spend.pools.length).toBeGreaterThan(0);
    expect(spend.pools.every(row => row.reason === 'status missing or stale')).toBe(true);
    expect(spend.pools.every(row => row.usedPercent === null && row.projectedUnusedPercent === null)).toBe(true);
  });

  it('returns unknown rows without throwing for malformed JSON and a missing file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const malformed = await statusFile('{definitely not json');
    for (const path of [malformed, `${malformed}.absent`]) {
      const spend = await readUsageSpend(path);
      expect(spend.v).toBe(1);
      expect(spend.pools.length).toBeGreaterThan(0);
      expect(spend.pools.every(row => row.reason === 'status missing or stale' && row.usedPercent === null)).toBe(true);
    }
  });
});
