import { describe, expect, it } from 'vitest';
import { GROK_ULTRA_RESET_AT, grokManualSensorReadings } from '../src/core/usage/grok-resource.js';
import { fleetPaceAdvice, paceAgainstCeiling } from '../src/core/usage/sensor-pace.js';
import { presentUsageSensors, type UsageSensorReading } from '../src/core/usage/sensor-reading.js';
import { projectWorldModel } from '../src/core/world/project.js';

const OBSERVED = Date.parse('2026-11-09T07:12:00.000Z');
const LATER = Date.parse('2026-11-12T12:00:00.000Z');

function spent(): UsageSensorReading {
  return { ...grokManualSensorReadings(OBSERVED)[0]!, observedAt: new Date(LATER - 60_000).toISOString(),
    staleAfter: new Date(LATER + 60_000).toISOString(), used: 100 };
}

function world(sensors: ReturnType<typeof presentUsageSensors>, nowMs: number) {
  return projectWorldModel({
    nowMs, sensors, sensorRows: [], roster: null, claims: null, busReadable: null, queue: null, ci: null,
    updatePhase: null, bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null, stepsObservedAt: null, outcomes: null,
  }).sensors.lanes.find((lane) => lane.lane === 'grok-ultra')!;
}

describe('Grok as a world-model resource', () => {
  it('seeds the manual reading: 51.4% used at 02:12 ET, reset Nov 15 8:21 PM ET', () => {
    const [row] = grokManualSensorReadings(OBSERVED);
    expect(row).toMatchObject({ lane: 'grok-ultra', source: 'manual', used: 51.4, limit: 100, unit: 'percent' });
    expect(row!.observedAt).toBe(new Date('2026-11-09T02:12:00-05:00').toISOString());
    expect(GROK_ULTRA_RESET_AT).toBe(new Date('2026-11-15T20:21:00-05:00').toISOString());
    expect(grokManualSensorReadings(Date.parse(GROK_ULTRA_RESET_AT))).toEqual([]);
  });

  it('shows capacity and reset in the world model, and a stale reading is unknown, not room', () => {
    const fresh = world(presentUsageSensors(grokManualSensorReadings(OBSERVED), OBSERVED + 60_000), OBSERVED + 60_000);
    expect(fresh.used.value).toBe(51.4);
    expect(fresh.remaining.value).toBeCloseTo(48.6);
    expect(fresh.resetAt.value).toBe(GROK_ULTRA_RESET_AT);
    expect(fresh.zeroCapacityUntil.value).toBeNull();
    const stale = world(presentUsageSensors(grokManualSensorReadings(OBSERVED), LATER), LATER);
    expect(stale.headroom.value).toBeNull();
    expect(stale.resetAt.value).toBe(GROK_ULTRA_RESET_AT);
    expect(fleetPaceAdvice(presentUsageSensors(grokManualSensorReadings(OBSERVED), LATER))['grok-cli']).toBeUndefined();
  });

  it('treats a spent allowance as zero until the reset, even once the reading is stale', () => {
    const later = LATER + 3 * 24 * 3_600_000; // past staleAfter, before the reset
    const report = presentUsageSensors([spent()], later);
    expect(report.lanes.find((lane) => lane.lane === 'grok-ultra')!.zeroCapacityUntil).toBe(GROK_ULTRA_RESET_AT);
    expect(fleetPaceAdvice(report)['grok-cli']).toEqual({ remaining: 0, resetAt: GROK_ULTRA_RESET_AT, burnPerHour: null });
    const lane = world(report, later);
    expect(lane.remaining.value).toBe(0);
    expect(lane.zeroCapacityUntil.value).toBe(GROK_ULTRA_RESET_AT);
    expect(paceAgainstCeiling({ remaining: 0, resetAt: GROK_ULTRA_RESET_AT, burnPerHour: null }, 2, later, false))
      .toEqual({ lane: 'lane', target: 0, reason: 'exhausted' });
  });

  it('lets the lane come back after the reset', () => {
    const after = Date.parse(GROK_ULTRA_RESET_AT) + 1;
    const report = presentUsageSensors([spent()], after);
    expect(report.lanes.find((lane) => lane.lane === 'grok-ultra')!.zeroCapacityUntil).toBeNull();
    expect(fleetPaceAdvice(report)['grok-cli']).toBeUndefined();
  });
});
