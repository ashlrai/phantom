import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cmdUsage } from '../src/cli/usage.js';
import { DevinConsumptionCache } from '../src/core/devin/consumption.js';
import { parseDevinDailyConsumption } from '../src/core/devin/client.js';
import { getFleetLaneSnapshot } from '../src/core/fleet/lane-console.js';
import { readMissionControl } from '../src/core/fleet/mission-control.js';
import { assessSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import {
  SENSOR_TIMESTAMP_BASELINE,
  USAGE_SENSOR_LANES,
  USAGE_SENSOR_SCHEMA,
  presentUsageSensors,
  readingIsFresh,
  usageSensorReadingSchema,
  type UsageSensorReading,
} from '../src/core/usage/sensor-reading.js';
import {
  parseDevinDailyAcu,
  refreshUsageSensors,
} from '../src/core/usage/sensor-refresh.js';
import { pullOfficialUsageSensors, refreshStalePersonalUsage } from '../src/core/usage/sensor-pull.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/usage-sensors/${name}`, import.meta.url), 'utf8'));

const reading = (extra: Partial<UsageSensorReading> = {}): UsageSensorReading => ({
  lane: 'devin',
  observedAt: '2026-11-09T11:50:00.000Z',
  source: 'devin-api-v3-daily',
  staleAfter: '2026-11-09T12:05:00.000Z',
  used: 10,
  limit: 30,
  unit: 'acu',
  resetAt: null,
  ...extra,
});

describe('usage sensor schema', () => {
  it('requires observedAt, source and staleAfter and rejects extra fields', () => {
    expect(usageSensorReadingSchema.safeParse(reading()).success).toBe(true);
    const { staleAfter: _staleAfter, ...missing } = reading();
    expect(usageSensorReadingSchema.safeParse(missing).success).toBe(false);
    expect(usageSensorReadingSchema.safeParse({ ...reading(), token: 'cog_secret' }).success).toBe(false);
    expect(usageSensorReadingSchema.safeParse({ ...reading(), observedAt: '2026-11-09T11:50:00Z' }).success).toBe(false);
  });

  it('reports the pre-change timestamp share and stamps every lane after', () => {
    expect(SENSOR_TIMESTAMP_BASELINE).toEqual({ timestamped: 9, total: 12 });
    const report = presentUsageSensors([reading()], NOW);
    expect(report.schema).toBe(USAGE_SENSOR_SCHEMA);
    expect(report.lanes.map(lane => lane.lane)).toEqual([...USAGE_SENSOR_LANES]);
    expect(report.lanes.every(lane => 'observedAt' in lane && 'source' in lane && 'staleAfter' in lane)).toBe(true);
    const stamped = report.lanes.filter(lane => lane.observedAt !== null && lane.source !== null && lane.staleAfter !== null);
    expect(stamped).toHaveLength(report.lanes.length);
  });
});

describe('stale sensor readings are unknown', () => {
  it('keeps a fresh reading spendable and drops one past staleAfter', () => {
    const fresh = presentUsageSensors([reading()], NOW).lanes.find(lane => lane.lane === 'devin')!;
    expect(fresh).toMatchObject({ status: 'fresh', stale: false, ageMs: 10 * 60_000, headroom: 20, used: 10, limit: 30 });

    const stale = presentUsageSensors([reading({
      observedAt: '2026-11-09T11:30:00.000Z',
      staleAfter: '2026-11-09T11:45:00.000Z',
      used: 1,
      limit: 30,
    })], NOW).lanes.find(lane => lane.lane === 'devin')!;
    expect(stale).toMatchObject({
      status: 'unknown', stale: true, ageMs: 30 * 60_000, headroom: null, used: 1, limit: 30,
    });
    expect(readingIsFresh({
      observedAt: '2026-11-09T11:30:00.000Z',
      staleAfter: '2026-11-09T11:45:00.000Z',
      nowMs: NOW,
    })).toBe(false);
  });

  it('does not treat a within-age seat as headroom once staleAfter has passed', () => {
    const capacity: SeatCapacity = {
      seatId: 'claude',
      engine: 'claude',
      label: 'claude',
      free: false,
      windows: [
        { id: 'five_hour', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
        { id: 'seven_day', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
      ],
      signedOut: false,
      reachable: null,
      contextWindow: 200_000,
      observedAt: new Date(NOW - 60_000).toISOString(),
      staleAfter: new Date(NOW - 1_000).toISOString(),
      spentTodayUsd: null,
    };
    const assessed = assessSeat(capacity, { seatId: 'claude', enabled: true, reservePercent: 0 }, { nowMs: NOW });
    expect(assessed.unknownUsage).toBe(true);
    expect(assessed.headroom.eligibleForAutonomy).toBe(false);
    expect(assessed.headroom.autonomyHeadroomPercent).toBeNull();
  });
});

describe('official usage fixtures', () => {
  it('parses Devin daily ACU used against the org cap', () => {
    const daily = fixture('devin-daily.json');
    expect(parseDevinDailyConsumption(daily)?.totalAcus).toBe(40);
    const parsed = parseDevinDailyAcu(daily, fixture('devin-limit.json'), NOW);
    expect(parsed).toMatchObject({
      lane: 'devin', source: 'devin-api-v3-daily', used: 40, limit: 30, unit: 'acu',
      observedAt: '2026-11-09T12:00:00.000Z', staleAfter: '2026-11-09T12:15:00.000Z',
    });
    expect(presentUsageSensors([parsed!], NOW).lanes.find(lane => lane.lane === 'devin')!.headroom).toBe(0);
  });

  it('does not infer a missing Devin product bucket as zero', () => {
    expect(parseDevinDailyAcu(fixture('devin-daily-incomplete.json'), fixture('devin-limit.json'), NOW)).toBeNull();
  });

  it('refreshes Codex, Claude and Grok from official status fixtures and leaves the rest unknown', () => {
    const readings = refreshUsageSensors({
      nowMs: NOW,
      devin: { daily: fixture('devin-daily.json'), limit: fixture('devin-limit.json') },
      codexCmp: fixture('codex-rate-limits.json'),
      claude: JSON.stringify(fixture('claude-usage.json')),
      grok: fixture('grok-status.json'),
    });
    const report = presentUsageSensors(readings, NOW);
    expect(report.lanes.find(lane => lane.lane === 'codex-cmp')).toMatchObject({
      status: 'fresh', source: 'codex-app-server', used: 40, limit: 100, headroom: 60,
    });
    expect(report.lanes.find(lane => lane.lane === 'claude-max')).toMatchObject({
      status: 'fresh', source: 'claude-usage', used: 63, limit: 100, headroom: 37,
    });
    expect(report.lanes.find(lane => lane.lane === 'grok-ultra')).toMatchObject({
      status: 'fresh', source: 'grok-status', used: 12, headroom: 88,
    });
    expect(report.lanes.find(lane => lane.lane === 'codex-personal')).toMatchObject({
      status: 'unknown', source: 'unmeasured', headroom: null,
    });
    expect(report.lanes.find(lane => lane.lane === 'terra')).toMatchObject({ status: 'unknown', headroom: null });
  });
});

describe('official refresh refuses operator credential homes', () => {
  it('refreshes a stale personal reading once, and keeps failures unknown', async () => {
    const stale = reading({ lane: 'codex-personal', source: 'codex-app-server', unit: 'percent', limit: 100,
      staleAfter: new Date(NOW).toISOString() });
    const readCodex = vi.fn(async () => ({ pctUsed: 42, resetAt: '2026-11-16T12:00:00.000Z' }));
    const options = { nowMs: NOW, operatorHome: '/home/operator', codexPersonalHome: '/srv/personal', readCodex };
    const refreshed = await refreshStalePersonalUsage([stale], options);
    expect(readCodex).toHaveBeenCalledWith('/srv/personal');
    expect(presentUsageSensors(refreshed, NOW).lanes.find(row => row.lane === 'codex-personal'))
      .toMatchObject({ status: 'fresh', used: 42, reason: null });
    await refreshStalePersonalUsage(refreshed, options);
    expect(readCodex).toHaveBeenCalledTimes(1);
    const failed = await refreshStalePersonalUsage([stale], { ...options, readCodex: async () => { throw new Error(); } });
    expect(presentUsageSensors(failed, NOW).lanes.find(row => row.lane === 'codex-personal'))
      .toMatchObject({ status: 'unknown', headroom: null, reason: 'Usage reading is stale' });
  });

  it('reports a missing Claude source as unknown with a reason', () => {
    const claude = presentUsageSensors([], NOW).lanes.find(row => row.lane === 'claude-max');
    expect(claude).toMatchObject({ status: 'unknown', used: null, reason: 'No usage source available' });
    expect(JSON.stringify(claude)).not.toContain('ask Mason');
  });
  it('does not call Codex when the home is the operator .codex directory', async () => {
    const readCodex = vi.fn(async () => ({ pctUsed: 1, resetAt: '2026-11-16T12:00:00.000Z' }));
    const readings = await pullOfficialUsageSensors({
      nowMs: NOW,
      operatorHome: '/home/operator',
      codexCmpHome: '/home/operator/.codex',
      codexPersonalHome: '/home/operator/.codex-2/sessions',
      readCodex,
      readDevin: async () => ({ status: 'unknown', reason: 'missing-key' }),
      readClaude: () => null,
    });
    expect(readCodex).not.toHaveBeenCalled();
    const codex = readings.find(row => row.lane === 'codex-cmp')!;
    expect(codex.source).toBe('unmeasured');
    expect(presentUsageSensors([codex], NOW).lanes.find(lane => lane.lane === 'codex-cmp')!.headroom).toBeNull();
  });

  it('reads an explicit Codex pool home through the official status parser', async () => {
    const readCodex = vi.fn(async () => ({ pctUsed: 40, resetAt: '2026-11-16T12:00:00.000Z' }));
    const readings = await pullOfficialUsageSensors({
      nowMs: NOW,
      operatorHome: '/home/operator',
      codexCmpHome: '/srv/pools/codex-cmp',
      readCodex,
      readDevin: async () => ({ status: 'unknown', reason: 'missing-key' }),
      readClaude: () => null,
      readGrok: () => null,
    });
    expect(readCodex).toHaveBeenCalledTimes(1);
    expect(readCodex).toHaveBeenCalledWith('/srv/pools/codex-cmp');
    expect(readings.find(row => row.lane === 'codex-cmp')).toMatchObject({
      source: 'codex-app-server', used: 40, limit: 100, unit: 'percent',
    });
  });

  it('keeps the parser free of filesystem and credential-directory access', () => {
    const source = readFileSync(new URL('../src/core/usage/sensor-refresh.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain('~/.codex');
    expect(source).not.toContain('/.codex');
    expect(source).not.toContain('homedir');
    expect(source).not.toContain('readFile');
  });
});

describe('phm usage sensors --json', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('prints age and stale status without echoing rejected secret fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-sensors-'));
    dirs.push(dir);
    const file = join(dir, 'usage-sensors.json');
    await writeFile(file, JSON.stringify({
      schema: USAGE_SENSOR_SCHEMA,
      readings: [
        reading(),
        { ...reading({ lane: 'grok-ultra', source: 'grok-status', used: 12, limit: 100, unit: 'percent' }), apiKey: 'cog_secretvalue' },
      ],
    }));
    vi.useFakeTimers({ now: NOW });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let code = 1;
    try { code = await cmdUsage(['sensors', '--json', '--file', file]); }
    finally { vi.useRealTimers(); }
    expect(code).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.schema).toBe(USAGE_SENSOR_SCHEMA);
    expect(report.lanes.find((lane: { lane: string }) => lane.lane === 'devin')).toMatchObject({
      status: 'fresh', ageMs: 10 * 60_000, stale: false, headroom: 20,
    });
    expect(JSON.stringify(report)).not.toContain('cog_secretvalue');
    expect(JSON.stringify(report)).not.toContain(file);
  });
});

describe('journal consumers', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('does not publish a stale usage journal row as lane headroom', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-journal-'));
    dirs.push(dir);
    const queue = join(dir, 'queue');
    const budgets = join(dir, 'budgets');
    await mkdir(queue, { recursive: true });
    await mkdir(budgets, { recursive: true });
    const log = join(queue, 'usage-readings.log');
    await writeFile(log, JSON.stringify({
      pool: 'grok-ultra', pctUsed: 10, fetchedAt: '2026-11-09T11:30:00.000Z',
    }));
    const snapshot = await getFleetLaneSnapshot({
      queueDir: queue, budgetsDir: budgets, usageLogPaths: [log], now: () => new Date(NOW),
    });
    expect(snapshot.lanes.find(lane => lane.lane === 'grok-ultra')!.credit).toMatchObject({
      state: 'unknown', remainingPct: null,
    });
  });

  it('does not publish a stale usage journal as mission-control headroom', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-mission-'));
    dirs.push(dir);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue/usage-readings.log'), JSON.stringify({
      pool: 'codex-personal', pctUsed: 10, resetAt: '2026-11-16T06:00:00Z', fetchedAt: '2026-11-09T11:30:00.000Z',
    }));
    const view = await readMissionControl({ runsDir: dir, now: () => NOW });
    expect(view.resources).toEqual([]);
  });
});

describe('Devin consumption cache', () => {
  it('carries observedAt and staleAfter and is not current once the deadline passes', async () => {
    const cache = new DevinConsumptionCache();
    const report = parseDevinDailyConsumption(fixture('devin-daily.json'))!;
    let now = NOW;
    const ready = await cache.refresh({
      identity: () => 'org-A/key-1',
      now: () => new Date(now),
      read: async () => report,
    });
    expect(ready.observedAt).toBe(new Date(NOW).toISOString());
    expect(ready.staleAfter).toBe(ready.expiresAt);
    expect(ready.stale).toBe(false);
    now += 5 * 60_000;
    const stale = cache.peek('org-A/key-1', new Date(now));
    expect(stale.stale).toBe(true);
    expect(readingIsFresh({ observedAt: stale.observedAt, staleAfter: stale.staleAfter, nowMs: now })).toBe(false);
  });
});
