import { describe, expect, it } from 'vitest';
import { describeFleetRuns, fleetRunsIdle, fleetRunsTone } from './fleet-runs-badge.js';
import { railBadgeFor } from './RailStatus.js';
import { activity } from './shell-fixtures.test-support.js';

const idle = { workers: 0, merges: 0, switchesOn: [] };

describe('fleet idle', () => {
  it('requires zero workers and a known zero merge count', () => {
    expect(fleetRunsIdle(idle)).toBe(true);
    for (const runs of [{ ...idle, workers: 1 }, { ...idle, merges: 1 }, { ...idle, merges: null }]) {
      expect(fleetRunsIdle(runs)).toBe(false);
      expect(describeFleetRuns(runs)).not.toContain('fleet idle');
    }
    expect(describeFleetRuns(idle)).toContain(' · fleet idle');
  });

  it('warns for idle or switches and otherwise runs', () => {
    expect(fleetRunsTone(idle)).toBe('warning');
    expect(fleetRunsTone({ ...idle, workers: 1, switchesOn: ['HOLD'] })).toBe('warning');
    expect(fleetRunsTone({ ...idle, workers: 1 })).toBe('running');
    const autonomy = { mode: 'propose' as const, paused: false, stopped: false, label: 'Propose' };
    expect(railBadgeFor('fleet', activity({ autonomy }), idle)?.tone).toBe('warning');
  });
});
