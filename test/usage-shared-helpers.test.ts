import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openUsageBrowserSession } from '../src/core/usage/live/browser.js';
import { readDispatchStatus } from '../src/core/usage/pace.js';
import { defaultResourceLiveRunsDir } from '../src/core/usage/resource-live/feed.js';
import {
  asUsageRecord,
  formatDurationMinutes,
  isFiniteNumber,
  isRefusedCodexPath,
  isUsageRecord,
  nonNegativeFinite,
  parseDispatchStatus,
  parseUnixSecondsOrIsoMs,
  roundTo,
} from '../src/core/usage/runway.js';
import { fleetPaceAdvice } from '../src/core/usage/sensor-pace.js';
import { pullOfficialUsageSensors } from '../src/core/usage/sensor-pull.js';
import { ACTIVE_USAGE_SENSOR_LANES, presentUsageSensors } from '../src/core/usage/sensor-reading.js';
import { readDispatchStatus as spendReadDispatchStatus } from '../src/core/usage/spend.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('shared usage primitives (runway.ts)', () => {
  it('guards plain records and numbers without fabricating values', () => {
    expect(isUsageRecord({ a: 1 })).toBe(true);
    expect(isUsageRecord(null)).toBe(false);
    expect(isUsageRecord([1, 2])).toBe(false);
    expect(asUsageRecord({ k: 'v' })).toEqual({ k: 'v' });
    expect(asUsageRecord('nope')).toEqual({});

    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(nonNegativeFinite(0)).toBe(0);
    expect(nonNegativeFinite(-0.1)).toBeNull();
    expect(nonNegativeFinite('5')).toBeNull();
    expect(roundTo(1.236, 1)).toBe(1.2);
    expect(roundTo(1.236, 2)).toBe(1.24);
    expect(roundTo(1.2346, 3)).toBe(1.235);
  });

  it('formats minute durations and parses ISO or Unix-second timestamps', () => {
    expect(formatDurationMinutes(40)).toBe('40m');
    expect(formatDurationMinutes(312)).toBe('5h 12m');
    expect(formatDurationMinutes(3 * 1440 + 4 * 60 + 55)).toBe('3d 4h');

    expect(parseUnixSecondsOrIsoMs('2026-11-26T12:00:00Z')).toBe(NOW);
    expect(parseUnixSecondsOrIsoMs(NOW / 1000)).toBe(NOW);
    expect(Number.isNaN(parseUnixSecondsOrIsoMs(9e12))).toBe(true);
    expect(Number.isNaN(parseUnixSecondsOrIsoMs(null))).toBe(true);
  });

  it('rejects .codex* paths across separators and parses dispatchd.status.v1 freshness', () => {
    expect(isRefusedCodexPath('/Users/test/.codex/queue')).toBe(true);
    expect(isRefusedCodexPath('/Users/test/.codex-2')).toBe(true);
    expect(isRefusedCodexPath('C:\\Users\\test\\.codex\\state')).toBe(true);
    expect(isRefusedCodexPath('/tmp/codex-personal/queue')).toBe(false);

    const fresh = parseDispatchStatus(
      { schema: 'dispatchd.status.v1', last_tick: new Date(NOW - 30_000).toISOString(), budget: { claude: {} }, lanes: { claude: { running: 1 } } },
      NOW,
    );
    expect(fresh.fresh).toBe(true);
    expect(fresh.asOf).toBe(new Date(NOW - 30_000).toISOString());
    expect(fresh.budget).toHaveProperty('claude');
    expect(fresh.lanes).toHaveProperty('claude');

    expect(parseDispatchStatus({ schema: 'dispatchd.status.v1', last_tick: new Date(NOW - 121_000).toISOString() }, NOW).fresh).toBe(false);
    expect(parseDispatchStatus({ schema: 'dispatchd.status.v1', last_tick: new Date(NOW + 1_000).toISOString() }, NOW).fresh).toBe(false);
    expect(parseDispatchStatus({ schema: 'other', last_tick: new Date(NOW).toISOString() }, NOW).fresh).toBe(false);
    expect(parseDispatchStatus({ schema: 'dispatchd.status.v1', last_tick: new Date(NOW - 240_000).toISOString() }, NOW, 300_000).fresh).toBe(true);
  });
});

describe('consolidated dispatch status reader and browser/runs helpers', () => {
  it('shares one bounded readDispatchStatus implementation between pace.ts and spend.ts', async () => {
    expect(spendReadDispatchStatus).toBe(readDispatchStatus);
    const dir = await mkdtemp(join(tmpdir(), 'usage-shared-'));
    dirs.push(dir);
    const path = join(dir, 'status.json');
    await writeFile(path, JSON.stringify({ schema: 'dispatchd.status.v1', ok: true }));
    expect(await readDispatchStatus(path)).toEqual({ schema: 'dispatchd.status.v1', ok: true });
    expect(await readDispatchStatus(join(dir, 'absent.json'))).toBeNull();
  });

  it('opens a valid usage browser session and degrades cleanly when the launcher fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'usage-browser-'));
    dirs.push(home);
    const close = vi.fn().mockResolvedValue(undefined);
    const launch = vi.fn().mockResolvedValue({ newPage: vi.fn(), close });
    const errors: string[] = [];

    const opened = await openUsageBrowserSession({
      home, headed: true, launch, unavailableMessage: 'no browser', err: line => errors.push(line),
    });
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.session).not.toBeNull();
    expect(launch).toHaveBeenCalledWith(join(home, '.ashlr-runs', 'usage-browser'), { headless: false });
    expect(errors).toEqual([]);

    const fallback = await openUsageBrowserSession({
      home, headed: false, launch: async () => { throw new Error('missing'); },
      unavailableMessage: 'browser unavailable', err: line => errors.push(line),
    });
    expect(fallback).toEqual({ ok: true, session: null });
    expect(errors).toEqual(['browser unavailable']);

    const refused = await openUsageBrowserSession({
      home: '/Users/example/.codex', headed: false, launch, unavailableMessage: 'unused', err: line => errors.push(line),
    });
    expect(refused).toEqual({ ok: false });
    expect(errors.at(-1)).toBe('Usage browser profile path refused.');
  });

  it('resolves defaultResourceLiveRunsDir with explicit home fallback', () => {
    const prev = process.env['ASHLR_RUNS_DIR'];
    try {
      delete process.env['ASHLR_RUNS_DIR'];
      expect(defaultResourceLiveRunsDir('/tmp/custom-home')).toBe('/tmp/custom-home/.ashlr-runs');
      process.env['ASHLR_RUNS_DIR'] = 'relative/ignored';
      expect(defaultResourceLiveRunsDir('/tmp/custom-home')).toBe('/tmp/custom-home/.ashlr-runs');
      process.env['ASHLR_RUNS_DIR'] = '/tmp/explicit-runs';
      expect(defaultResourceLiveRunsDir('/tmp/custom-home')).toBe('/tmp/explicit-runs');
    } finally {
      if (prev === undefined) delete process.env['ASHLR_RUNS_DIR'];
      else process.env['ASHLR_RUNS_DIR'] = prev;
    }
  });
});

describe('sensor-pace and sensor-pull pruned dead-code regressions', () => {
  it('projects fleet pace advice for codex, claude, grok and local lanes', () => {
    const staleAfter = new Date(NOW + 10 * 60_000).toISOString();
    const resetAt = new Date(NOW + 24 * 3_600_000).toISOString();
    const report = presentUsageSensors([
      { lane: 'codex-personal', observedAt: new Date(NOW).toISOString(), source: 'codex-app-server', staleAfter, used: 20, limit: 100, unit: 'percent', resetAt },
      { lane: 'claude-max', observedAt: new Date(NOW).toISOString(), source: 'claude-usage', staleAfter, used: 35, limit: 100, unit: 'percent', resetAt },
      { lane: 'grok-ultra', observedAt: new Date(NOW).toISOString(), source: 'grok-status', staleAfter, used: 10, limit: 100, unit: 'percent', resetAt },
      { lane: 'local', observedAt: new Date(NOW).toISOString(), source: 'local-throughput', staleAfter, used: 4, limit: null, unit: null, resetAt: null },
    ], NOW);
    const advice = fleetPaceAdvice(report);
    expect(advice.codex?.remaining).toBe(80);
    expect(advice['claude-cli']?.remaining).toBe(65);
    expect(advice['grok-cli']?.remaining).toBe(90);
    expect(advice.local?.uncapped).toBe(true);
  });

  it('emits unmeasured rows for all active lanes including terra when sources return nothing', async () => {
    const readings = await pullOfficialUsageSensors({
      nowMs: NOW,
      readDevin: async () => ({ status: 'unknown', reason: 'missing-key' }),
      readClaude: () => null,
      readGrok: () => null,
    });
    expect(readings.map(r => r.lane)).toEqual(ACTIVE_USAGE_SENSOR_LANES);
    expect(readings.every(r => r.source === 'unmeasured')).toBe(true);
  });
});
