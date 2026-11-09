import { describe, expect, it } from 'vitest';
import { presentUsageSensors } from '../src/core/usage/sensor-reading.js';
import { projectWorldModel } from '../src/core/world/project.js';
import { worldGet } from '../src/core/world/path.js';
import { clearWorldCacheForTests, readWorldModel } from '../src/core/world/read.js';
import type { AgentRoster } from '../src/core/fleet/agent-roster.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

function roster(): AgentRoster {
  return {
    schema: 'agent-roster.v1',
    observedAt: new Date(NOW).toISOString(),
    latencyMs: 1,
    sources: [{
      source: 'claude', ok: true, availability: 'known', sessions: [],
      error: null, observedAt: new Date(NOW).toISOString(), truncated: false,
    }],
    sessions: [],
    claims: { source: 'missing', items: [] },
  };
}

describe('ashlr.world-model/v1', () => {
  it('keeps a missing queue and absent pace unknown, and a fresh empty roster at zero', () => {
    const sensors = presentUsageSensors([{
      lane: 'claude-max', observedAt: new Date(NOW).toISOString(), source: 'claude-usage',
      staleAfter: new Date(NOW + 60_000).toISOString(), used: 10, limit: 100, unit: 'percent', resetAt: null,
    }], NOW);
    const model = projectWorldModel({
      nowMs: NOW,
      sensors,
      sensorRows: sensors.lanes,
      roster: roster(),
      claims: { source: 'available', claims: [] },
      busReadable: null,
      queue: null,
      ci: null,
      updatePhase: null,
      bottlenecks: null,
      bottlenecksObservedAt: null,
      stepsRemaining: null,
      stepsObservedAt: null,
      outcomes: null,
    });
    expect(model.schema).toBe('ashlr.world-model/v1');
    expect(model.queue.ready).toEqual({ value: null, source: 'queue.v1', observedAt: null, freshness: 'unknown' });
    expect(model.claims.live.value).toBe(0);
    expect(model.roster.sessions.value).toBe(0);
    const claude = model.sensors.lanes.find((lane) => lane.lane === 'claude-max');
    expect(claude?.headroom.value).toBe(90);
    expect(claude?.pacePerHour.freshness).toBe('unknown');
    expect(claude?.pacePerHour.value).toBeNull();
    const pace = model.blindSpots.find((spot) => spot.path === 'sensors.lanes.claude-max.pacePerHour');
    expect(pace).toMatchObject({ id: 'sensors-lanes-claude-max-pacePerHour', freshness: 'unknown' });
    expect(pace?.need).toContain('RQ-SENSORS-PACE-1');
    expect(model.blindSpots.filter((spot) => spot.path === 'sensors.lanes.claude-max.used')).toEqual([]);
    expect(new Set(model.blindSpots.map((spot) => spot.id)).size).toBe(model.blindSpots.length);
    expect(model.blindSpots.some((spot) => spot.path === 'outcomes.repos')).toBe(true);
    expect(JSON.stringify(model.queue)).not.toContain('"value":0');
  });

  it('reads a pacing field when RQ-SENSORS-PACE-1 has added it', () => {
    const sensors = presentUsageSensors([{
      lane: 'devin', observedAt: new Date(NOW).toISOString(), source: 'devin-api-v3-daily',
      staleAfter: new Date(NOW + 60_000).toISOString(), used: 1, limit: 10, unit: 'acu', resetAt: null,
    }], NOW);
    const model = projectWorldModel({
      nowMs: NOW, sensors, sensorRows: [{ lane: 'devin', pacePerHour: 0.5, requiredPacePerHour: 1, runwayHours: 4 }],
      roster: null, claims: null, busReadable: null, queue: null, ci: null, updatePhase: null,
      bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null, stepsObservedAt: null, outcomes: null,
    });
    expect(model.sensors.lanes.find((lane) => lane.lane === 'devin')?.pacePerHour.value).toBe(0.5);
    expect(worldGet(model, 'sensors.lanes.devin.pacePerHour.value')).toBe(0.5);
    expect(worldGet(model, 'sensors.lanes.missing.headroom')).toMatchObject({ freshness: 'unknown', value: null });
  });

  it('serves a warm path read under 50ms at p95', () => {
    const model = projectWorldModel({
      nowMs: NOW, sensors: presentUsageSensors([], NOW), sensorRows: [], roster: roster(),
      claims: { source: 'available', claims: [] }, busReadable: true, queue: { ready: 2, claimed: 1 },
      ci: null, updatePhase: 'failed', bottlenecks: 1, bottlenecksObservedAt: new Date(NOW).toISOString(),
      stepsRemaining: 2, stepsObservedAt: new Date(NOW).toISOString(), outcomes: null,
    });
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      worldGet(model, 'sensors.lanes.claude-max.headroom');
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(50);
  });

  it('reuses the process cache on the second tick', async () => {
    clearWorldCacheForTests();
    const first = await readWorldModel({ nowMs: Date.now() });
    const second = await readWorldModel({ nowMs: Date.now() });
    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
    expect(second.schema).toBe('ashlr.world-model/v1');
    expect(second.views.observe.coverage.unknownFields.map((field) => field.path)).toEqual(second.blindSpots.map((spot) => spot.path));
    clearWorldCacheForTests();
  });
});
