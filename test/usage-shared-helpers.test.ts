import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asUsageRecord,
  isCanonicalIsoTimestamp,
  isFiniteUsageNumber,
  isUsageRecord,
  nonNegativeUsageNumber,
  parseDispatchStatus,
  parseUsageTimestampMs,
  roundUsage,
} from '../src/core/usage/runway.js';
import { canonicalIsoTimestampSchema } from '../src/core/usage/sensor-reading.js';
import { defaultDispatchStatusPath, readDispatchStatus } from '../src/core/usage/pace.js';
import {
  absolutePathOrUndefined,
  defaultUsageRunsDir,
  hasCodexPathSegment,
  openUsageBrowserSession,
  usageBrowserDir,
  type BrowserSession,
} from '../src/core/usage/live/browser.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('usage shared helpers', () => {
  it('narrows plain records and finite non-negative numbers', () => {
    const rec = { a: 1 };
    expect(isUsageRecord(rec)).toBe(true);
    expect(asUsageRecord(rec)).toBe(rec);
    for (const bad of [null, undefined, 'x', 1, true, []]) {
      expect(isUsageRecord(bad)).toBe(false);
      expect(asUsageRecord(bad)).toEqual({});
    }
    expect(isFiniteUsageNumber(-3.5)).toBe(true);
    expect(nonNegativeUsageNumber(0)).toBe(0);
    expect(nonNegativeUsageNumber(-0.1)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      expect(isFiniteUsageNumber(bad)).toBe(false);
      expect(nonNegativeUsageNumber(bad)).toBeNull();
    }
    expect(roundUsage(12.346, 1)).toBe(12.3);
    expect(roundUsage(12.346, 2)).toBe(12.35);
    expect(roundUsage(12.3456, 3)).toBe(12.346);
  });

  it('validates canonical ISO instants and parses bounded epoch/ISO timestamps', () => {
    expect(isCanonicalIsoTimestamp('2026-11-20T12:00:00.000Z')).toBe(true);
    expect(canonicalIsoTimestampSchema.safeParse('2026-11-20T12:00:00.000Z').success).toBe(true);
    for (const bad of ['2026-11-20T12:00:00Z', '2026-11-20', 'not-a-date', 123, null]) {
      expect(isCanonicalIsoTimestamp(bad)).toBe(false);
      expect(canonicalIsoTimestampSchema.safeParse(bad).success).toBe(false);
    }
    expect(parseUsageTimestampMs('2026-11-20T00:00:00Z')).toBe(Date.parse('2026-11-20T00:00:00Z'));
    expect(parseUsageTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(Number.isNaN(parseUsageTimestampMs(1e20))).toBe(true);
    expect(Number.isNaN(parseUsageTimestampMs(null))).toBe(true);
  });

  it('evaluates dispatchd.status.v1 freshness and bounds status file reads', async () => {
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const fresh = parseDispatchStatus(
      { schema: 'dispatchd.status.v1', last_tick: '2026-11-20T11:58:00.000Z', budget: { claude: {} }, lanes: { claude: {} } },
      now,
    );
    expect(fresh.fresh).toBe(true);
    expect(fresh.asOf).toBe('2026-11-20T11:58:00.000Z');
    expect(Object.keys(fresh.budget)).toEqual(['claude']);
    expect(parseDispatchStatus({ schema: 'dispatchd.status.v1', last_tick: '2026-11-20T11:57:59.000Z' }, now).fresh).toBe(false);
    expect(parseDispatchStatus({ schema: 'other', last_tick: '2026-11-20T12:00:00.000Z' }, now).fresh).toBe(false);
    expect(defaultDispatchStatusPath('/tmp/runs')).toBe('/tmp/runs/queue/status.json');
    expect(await readDispatchStatus('/tmp/definitely-missing-dispatch-status.json')).toBeNull();
  });

  it('guards .codex paths, resolves runs dirs, and opens usage browser sessions cleanly', async () => {
    expect(hasCodexPathSegment('/Users/test/.codex')).toBe(true);
    expect(hasCodexPathSegment('/Users/test/.codex-2/auth')).toBe(true);
    expect(hasCodexPathSegment('/Users/test/codex-work')).toBe(false);
    expect(absolutePathOrUndefined('/abs/path')).toBe('/abs/path');
    expect(absolutePathOrUndefined('relative/path')).toBeUndefined();
    const prev = process.env['ASHLR_RUNS_DIR'];
    try {
      delete process.env['ASHLR_RUNS_DIR'];
      expect(defaultUsageRunsDir('/Users/example')).toBe('/Users/example/.ashlr-runs');
      process.env['ASHLR_RUNS_DIR'] = '/custom/runs';
      expect(defaultUsageRunsDir('/Users/example')).toBe('/custom/runs');
    } finally {
      if (prev === undefined) delete process.env['ASHLR_RUNS_DIR'];
      else process.env['ASHLR_RUNS_DIR'] = prev;
    }

    const home = await mkdtemp(join(tmpdir(), 'usage-browser-helper-'));
    tempDirs.push(home);
    const fakeSession: BrowserSession = { newPage: vi.fn(), close: vi.fn() };
    const launch = vi.fn().mockResolvedValue(fakeSession);
    expect(await openUsageBrowserSession({ home, headed: true, launch })).toEqual({ status: 'ok', session: fakeSession });
    expect(launch).toHaveBeenCalledWith(usageBrowserDir(home), { headless: false });
    expect(await openUsageBrowserSession({ home: '/tmp/.codex/home', launch })).toEqual({ status: 'refused' });
    expect(await openUsageBrowserSession({ home, launch: vi.fn().mockRejectedValue(new Error('no playwright')) })).toEqual({ status: 'unavailable' });
  });
});
