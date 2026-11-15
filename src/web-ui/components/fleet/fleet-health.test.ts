import { describe, expect, it } from 'vitest';
import type { FleetLaneSnapshot } from '../../data/api-types.js';
import { buildLaneHealth, liveOverTarget } from './fleet-health.js';

type Credit = FleetLaneSnapshot['lanes'][number]['credit'];

function credit(overrides: Partial<Credit>): Credit {
  return {
    state: 'unknown',
    label: 'unknown',
    remainingPct: null,
    remainingCredits: null,
    creditsUnit: null,
    resetAt: null,
    burnPerHour: null,
    projectedExhaustionAt: null,
    observedAt: null,
    source: null,
    ...overrides,
  };
}

function snapshot(lanes: Partial<FleetLaneSnapshot['lanes'][number]>[]): FleetLaneSnapshot {
  return { lanes } as FleetLaneSnapshot;
}

describe('buildLaneHealth', () => {
  it('projects live/target/queue/credit straight off the lane', () => {
    const [lane] = buildLaneHealth(
      snapshot([
        {
          lane: 'codex-personal',
          liveJobs: 12,
          slotTarget: 32,
          queueDepth: 7,
          mergesPerHour: 2,
          credit: credit({ state: 'observed', label: '64% weekly', remainingPct: 64 }),
          hold: null,
        },
      ]),
    );
    expect(lane).toMatchObject({
      lane: 'codex-personal',
      live: 12,
      target: 32,
      queue: 7,
      creditLabel: '64% weekly',
      creditPct: 64,
      held: false,
    });
    expect(liveOverTarget(lane!)).toBe('12/32');
  });

  it('renders honest nulls for unobserved counters and unknown credit', () => {
    const [lane] = buildLaneHealth(
      snapshot([
        {
          lane: 'zai',
          liveJobs: null,
          slotTarget: 3,
          queueDepth: null,
          mergesPerHour: null,
          credit: credit({}),
          hold: null,
        },
      ]),
    );
    expect(lane!.creditLabel).toBeNull();
    expect(lane!.creditPct).toBeNull();
    expect(liveOverTarget(lane!)).toBe('—/3');
  });

  it('surfaces holds with their reason', () => {
    const [lane] = buildLaneHealth(
      snapshot([
        {
          lane: 'gemini',
          liveJobs: 0,
          queueDepth: 4,
          credit: credit({ state: 'reset-pending', label: 'reset pending', resetAt: '2026-11-11T00:00:00Z' }),
          hold: { held: true, reason: 'autobackoff', until: null, by: 'autobackoff', since: null },
        },
      ]),
    );
    expect(lane!.held).toBe(true);
    expect(lane!.holdReason).toBe('autobackoff');
    expect(lane!.creditState).toBe('reset-pending');
    expect(liveOverTarget(lane!)).toBe('0/—');
  });

  it('clamps percentage readings into 0-100 and tolerates missing slotTarget', () => {
    const [lane] = buildLaneHealth(
      snapshot([
        {
          lane: 'claude',
          liveJobs: 2,
          queueDepth: 0,
          credit: credit({ state: 'observed', label: '120%', remainingPct: 120 }),
          hold: null,
        },
      ]),
    );
    expect(lane!.creditPct).toBe(100);
    expect(lane!.target).toBeNull();
    expect(buildLaneHealth(undefined)).toEqual([]);
  });
});
