import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyResources } from '../src/core/observe/resources.js';
import { projectSensors } from '../src/core/observe/sensors.js';
import { paceLane } from '../src/core/usage/sensor-pace.js';
import {
  includedWastePerWeek,
  presentUsageSensors,
  type UsageSensorReading,
} from '../src/core/usage/sensor-reading.js';
import { parseDevinDailyAcu, parseDevinIncluded, refreshUsageSensors } from '../src/core/usage/sensor-refresh.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const HOUR = 3_600_000;
const resetAt = new Date(NOW + 168 * HOUR).toISOString();

function sample(partial: Partial<UsageSensorReading> & Pick<UsageSensorReading, 'observedAt' | 'used'>): UsageSensorReading {
  return {
    lane: 'codex-personal',
    source: 'codex-app-server',
    staleAfter: new Date(NOW + 15 * 60_000).toISOString(),
    limit: 100,
    unit: 'percent',
    resetAt,
    ...partial,
  };
}

describe('lane pace', () => {
  const base = {
    lane: 'codex-personal',
    ceiling: 8,
    floor: 0,
    killed: false,
    nowMs: NOW,
    resetAt: new Date(NOW + 10 * HOUR).toISOString(),
  };

  it('lowers concurrency when the allowance would run dry early', () => {
    const decision = paceLane({ ...base, remaining: 100, burnPerJob: 20 });
    expect(decision).toEqual({ lane: 'codex-personal', target: 0, reason: 'paced' });
  });

  it('raises concurrency toward the ceiling when usage would be left idle', () => {
    const decision = paceLane({ ...base, remaining: 100, burnPerJob: 1, ceiling: 4 });
    expect(decision).toEqual({ lane: 'codex-personal', target: 4, reason: 'paced' });
  });

  it('returns unknown instead of zero when the burn or the reset is missing', () => {
    expect(paceLane({ ...base, remaining: 100, burnPerJob: null }).target).toBeNull();
    expect(paceLane({ ...base, remaining: null, burnPerJob: 1 })).toMatchObject({ target: null, reason: 'unknown' });
    expect(paceLane({ ...base, remaining: 100, burnPerJob: 1, resetAt: null }).reason).toBe('unknown');
  });

  it('keeps pay-per-use at 0 until a fresh balance is approved, and honors KILL', () => {
    expect(paceLane({ ...base, lane: 'claude-api', remaining: 40, burnPerJob: 1, payPerUse: true }).target).toBe(0);
    expect(paceLane({
      ...base, lane: 'claude-api', remaining: 50, burnPerJob: 1, payPerUse: true, balanceFresh: true, spendApproved: true, ceiling: 3,
    }).target).toBe(3);
    expect(paceLane({ ...base, remaining: 100, burnPerJob: 1, killed: true })).toEqual({ lane: 'codex-personal', target: 0, reason: 'kill' });
  });

  it('reports local throughput without an allowance', () => {
    expect(paceLane({ ...base, lane: 'local', remaining: null, burnPerJob: null, uncapped: true, ceiling: 4 }).target).toBe(4);
  });
});

describe('included waste forecast', () => {
  it('projects weekly underuse from two official points and does not treat the checked-in journal as zero', () => {
    const report = presentUsageSensors([
      sample({ observedAt: new Date(NOW - 2 * HOUR).toISOString(), used: 20, staleAfter: new Date(NOW - HOUR).toISOString() }),
      sample({ observedAt: new Date(NOW).toISOString(), used: 20.2 }),
    ], NOW);
    const personal = report.lanes.find((lane) => lane.lane === 'codex-personal')!;
    expect(personal).toMatchObject({
      status: 'fresh', remaining: 79.8, remainingUnit: 'percent', forecastVsReset: 'underuse',
    });
    expect(personal.burnRate).toBeCloseTo(0.1, 8);
    expect(personal.idleIncludedWastedPerWeek).toBeCloseTo(63, 5);
    expect(personal.forecastExhaustAt).not.toBeNull();
    const pacedJobs = 4;
    const unusedAfter = 100 - (20.2 + pacedJobs * 0.1 * 168);
    expect(unusedAfter).toBeCloseTo(12.6, 5);
    expect(includedWastePerWeek(presentUsageSensors([], NOW))).toBeNull();
    const journal = readFileSync(new URL('../usage-readings.log', import.meta.url), 'utf8');
    const fleet = readFileSync(new URL('./fixtures/fleet-lanes/queue/usage-readings.log', import.meta.url), 'utf8');
    const historical = [...journal.split('\n'), ...fleet.split('\n')].flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    expect(includedWastePerWeek(presentUsageSensors(historical, NOW))).toBeNull();
  });

  it('keeps the Devin ACU cap and records included allowances separately', () => {
    const daily = JSON.parse(readFileSync(new URL('./fixtures/usage-sensors/devin-daily.json', import.meta.url), 'utf8'));
    const limit = JSON.parse(readFileSync(new URL('./fixtures/usage-sensors/devin-limit.json', import.meta.url), 'utf8'));
    expect(parseDevinDailyAcu(daily, limit, NOW)?.limit).toBe(30);
    const flash = parseDevinIncluded('devin-swe-flash', { used: 10, limit: 100, unit: 'percent', resetAt }, NOW);
    expect(flash).toMatchObject({ lane: 'devin-swe-flash', used: 10, limit: 100, source: 'devin-included-allowance' });
    const readings = refreshUsageSensors({
      nowMs: NOW,
      devin: { daily, limit },
      devinSweFlash: { used: 10, limit: 100, unit: 'percent', resetAt },
      dot: { pctUsed: 15, resetAt },
      cursorCloud: { pctUsed: 40, resetAt },
      grokBot: { pctUsed: 5, resetAt },
      local: { completed: 3 },
    });
    const view = presentUsageSensors(readings, NOW);
    expect(view.lanes.find((lane) => lane.lane === 'devin')).toMatchObject({ limit: 30, unit: 'acu' });
    expect(view.lanes.find((lane) => lane.lane === 'dot')).toMatchObject({ status: 'fresh', used: 15, source: 'dot-status' });
    expect(view.lanes.find((lane) => lane.lane === 'cursor-cloud')?.status).toBe('fresh');
    expect(view.lanes.find((lane) => lane.lane === 'grok-bot')?.status).toBe('fresh');
    expect(view.lanes.find((lane) => lane.lane === 'local')).toMatchObject({ status: 'fresh', used: 3, limit: null, headroom: null, remaining: null });
    const windows = projectSensors(view, NOW);
    const { items } = classifyResources({
      roster: [{ source: 'dot', availability: 'known', sessions: [] }, { source: 'phantom', availability: 'known', sessions: [] }],
      claims: { source: 'missing', claims: [] },
      windows, nowMs: NOW, windowMs: 15 * 60_000,
    });
    const dot = items.find((item) => item.id === 'dot')!;
    expect(dot.state).toBe('idle');
    expect(dot.gauge.remaining).toBe(85);
    expect(dot.gauge.forecastVsReset).toBe('unknown');
    expect(dot.gauge.idleIncludedWastedPerWeek).toBeNull();
  });
});
