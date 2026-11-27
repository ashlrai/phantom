import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetCountdown } from '../src/core/usage/account-limits.js';
import {
  absolutePathOrUndefined,
  openUsageBrowserSession,
  type BrowserSession,
} from '../src/core/usage/live/browser.js';
import { readDispatchStatus as readDispatchStatusFromPace } from '../src/core/usage/pace.js';
import {
  asNonNegativeNumber,
  asUsageRecord,
  formatDurationMinutes,
  isCanonicalIsoTimestamp,
  isCodexHomePath,
  isFiniteNumber,
  isNonNegativeNumber,
  isUsageRecord,
  parseDispatchStatus,
  parseEpochOrIsoMs,
  raceWithDeadline,
  roundTo,
} from '../src/core/usage/resource-usage-types.js';
import { runwayHours } from '../src/core/usage/runway.js';
import { readDispatchStatus as readDispatchStatusFromSpend, spendCountdown } from '../src/core/usage/spend.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-shared-helpers-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('usage shared guards, rounding, duration, and status helpers', () => {
  it('narrows records and finite numbers consistently', () => {
    expect(isUsageRecord({ a: 1 })).toBe(true);
    expect(isUsageRecord(null)).toBe(false);
    expect(isUsageRecord([])).toBe(false);
    expect(isUsageRecord('text')).toBe(false);

    expect(asUsageRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asUsageRecord(null)).toEqual({});
    expect(asUsageRecord([1, 2])).toEqual({});

    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-3.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('5')).toBe(false);

    expect(isNonNegativeNumber(0)).toBe(true);
    expect(isNonNegativeNumber(42.5)).toBe(true);
    expect(isNonNegativeNumber(-0.1)).toBe(false);
    expect(asNonNegativeNumber(12)).toBe(12);
    expect(asNonNegativeNumber(-1)).toBeNull();
    expect(asNonNegativeNumber(Number.NaN)).toBeNull();
  });

  it('rounds decimals and formats minute durations consistently across countdown callers', () => {
    expect(roundTo(12.3456, 1)).toBe(12.3);
    expect(roundTo(12.3456, 2)).toBe(12.35);
    expect(roundTo(12.3456, 3)).toBe(12.346);

    expect(formatDurationMinutes(40)).toBe('40m');
    expect(formatDurationMinutes(5 * 60 + 12)).toBe('5h 12m');
    expect(formatDurationMinutes(3 * 1440 + 4 * 60 + 9)).toBe('3d 4h');

    const nowMs = Date.parse('2026-11-27T12:00:00.000Z');
    const inHours = 26.5;
    expect(spendCountdown(inHours)).toBe('1d 2h');
    expect(runwayHours(inHours)).toBe('1d 2h');
    expect(resetCountdown(new Date(nowMs + inHours * 3_600_000).toISOString(), nowMs)).toBe('in 1d 2h');
  });

  it('validates canonical ISO timestamps, parses epoch/ISO instants, and checks dispatchd status freshness', () => {
    expect(isCanonicalIsoTimestamp('2026-11-27T12:00:00.000Z')).toBe(true);
    expect(isCanonicalIsoTimestamp('2026-11-27T12:00:00Z')).toBe(false);
    expect(isCanonicalIsoTimestamp('not-a-date')).toBe(false);

    expect(parseEpochOrIsoMs('2026-11-27T12:00:00.000Z')).toBe(Date.parse('2026-11-27T12:00:00.000Z'));
    expect(parseEpochOrIsoMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(Number.isNaN(parseEpochOrIsoMs(1e15))).toBe(true);
    expect(Number.isNaN(parseEpochOrIsoMs(null))).toBe(true);

    const now = Date.parse('2026-11-27T12:01:00.000Z');
    const fresh = parseDispatchStatus({
      schema: 'dispatchd.status.v1',
      last_tick: '2026-11-27T12:00:00.000Z',
      budget: { claude: { ok: true } },
    }, now);
    expect(fresh.fresh).toBe(true);
    expect(fresh.asOf).toBe('2026-11-27T12:00:00.000Z');
    expect(fresh.budget).toEqual({ claude: { ok: true } });

    const stale = parseDispatchStatus({
      schema: 'dispatchd.status.v1',
      last_tick: '2026-11-27T11:55:00.000Z',
    }, now);
    expect(stale.fresh).toBe(false);

    const future = parseDispatchStatus({
      schema: 'dispatchd.status.v1',
      last_tick: '2026-11-27T12:05:00.000Z',
    }, now);
    expect(future.fresh).toBe(false);
  });

  it('rejects .codex* path segments and validates absolute paths', () => {
    expect(isCodexHomePath('/Users/alice/.codex')).toBe(true);
    expect(isCodexHomePath('/Users/alice/.codex-2/auth.json')).toBe(true);
    expect(isCodexHomePath('.codex/sessions')).toBe(true);
    expect(isCodexHomePath('/Users/alice/.ashlr-runs/codex-personal')).toBe(false);

    expect(absolutePathOrUndefined('/tmp/runs')).toBe('/tmp/runs');
    expect(absolutePathOrUndefined('relative/path')).toBeUndefined();
    expect(absolutePathOrUndefined(undefined)).toBeUndefined();
  });

  it('races tasks against deadlines across value, error, and timeout outcomes', async () => {
    expect(await raceWithDeadline(() => 'sync-ok', 200)).toEqual({ kind: 'value', value: 'sync-ok' });
    expect(await raceWithDeadline(async () => 42, 200)).toEqual({ kind: 'value', value: 42 });
    expect(await raceWithDeadline(() => { throw new Error('sync boom'); }, 200)).toEqual({ kind: 'error' });
    expect(await raceWithDeadline(async () => { throw new Error('async boom'); }, 200)).toEqual({ kind: 'error' });
    expect(await raceWithDeadline(() => new Promise(() => {}), 15)).toEqual({ kind: 'timeout' });
  });

  it('shares one bounded readDispatchStatus implementation across pace and spend', async () => {
    expect(readDispatchStatusFromSpend).toBe(readDispatchStatusFromPace);
    const dir = makeTempDir();
    const okPath = join(dir, 'status.json');
    writeFileSync(okPath, JSON.stringify({ schema: 'dispatchd.status.v1', ok: true }));
    expect(await readDispatchStatusFromPace(okPath)).toEqual({ schema: 'dispatchd.status.v1', ok: true });

    const bigPath = join(dir, 'oversized.json');
    writeFileSync(bigPath, ' '.repeat(1024 * 1024 + 8));
    expect(await readDispatchStatusFromPace(bigPath)).toBeNull();
    expect(await readDispatchStatusFromPace(join(dir, 'missing.json'))).toBeNull();
  });

  it('opens and validates the dedicated usage browser session through one helper', async () => {
    const fakeSession: BrowserSession = {
      newPage: async () => { throw new Error('unused'); },
      close: async () => {},
    };
    const home = makeTempDir();
    const opened = await openUsageBrowserSession({
      home,
      headed: false,
      launch: async () => fakeSession,
    });
    expect(opened).toEqual({ ok: true, session: fakeSession });

    const unavailable = await openUsageBrowserSession({
      home,
      headed: true,
      launch: async () => { throw new Error('playwright missing'); },
    });
    expect(unavailable).toEqual({ ok: false, reason: 'unavailable' });

    const refused = await openUsageBrowserSession({
      home: join(home, '.codex'),
      headed: false,
      launch: async () => fakeSession,
    });
    expect(refused).toEqual({ ok: false, reason: 'profile-refused' });
  });
});
