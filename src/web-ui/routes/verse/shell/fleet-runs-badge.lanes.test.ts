import { describe, expect, it } from 'vitest';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { describeFleetRuns, fleetRunsBadge, fleetRunsTone, underTargetLanes } from './fleet-runs-badge.js';

describe('fleet lane badge', () => {
  it('parses lane counts and personal usage and describes them', () => {
    const input = withLane(withLane(fleetRunsFixture({ switches: [] }),
      { lane: 'codex-personal', running: 24, target: 24 }), { lane: 'devin', running: 10, target: 10 });
    const badge = fleetRunsBadge({ ...input, codexPersonal: { usedPct: 87 } })!;
    expect(badge.lanes).toEqual([
      { lane: 'codex-personal', short: 'personal', running: 24, target: 24, held: false },
      { lane: 'devin', short: 'devin', running: 10, target: 10, held: false },
    ]);
    expect(badge.personalPct).toBe(87);
    expect(describeFleetRuns(badge)).toBe('1 worker running · 3 merged last hour · personal 24/24 · devin 10/10 · Codex personal 87%');
    expect(fleetRunsTone(badge)).toBe('running');
  });

  it('keeps a valid badge but suppresses all lane counts when one is invalid', () => {
    const input = fleetRunsFixture();
    for (const running of ['x', NaN, Infinity]) {
      const badge = fleetRunsBadge({ ...input, lanes: [{ ...input.lanes[0], running }] })!;
      expect(badge.lanes).toEqual([]);
      expect(Object.keys(badge)).not.toContain('lanes');
    }
    expect(fleetRunsBadge({ ...input, lanes: [{ ...input.lanes[0], held: 'yes' }] })).toBeNull();
  });

  it('warns only for active lanes below a positive target', () => {
    const input = withLane(withLane(fleetRunsFixture({ switches: [] }),
      { lane: 'codex-personal', held: true }), { lane: 'devin', running: 0, target: 0 });
    const held = fleetRunsBadge(input)!;
    expect(underTargetLanes(held)).toEqual([]);
    const badge = fleetRunsBadge(withLane(input, { lane: 'devin', running: 1, target: 2 }))!;
    expect(underTargetLanes(badge).map(lane => lane.lane)).toEqual(['devin']);
    expect(fleetRunsTone(badge)).toBe('warning');
    expect(fleetRunsTone(fleetRunsBadge(withLane(fleetRunsFixture({ switches: [] }),
      { lane: 'codex-personal', running: 4, target: 4 }))!)).toBe('warning');
  });

  it('accepts only finite percentages in range and keeps missing fields non-enumerable', () => {
    const input = fleetRunsFixture();
    for (const usedPct of [-1, 101, NaN, Infinity, '87', null]) {
      expect(fleetRunsBadge({ ...input, codexPersonal: { usedPct } })!.personalPct).toBeNull();
    }
    for (const usedPct of [0, 100]) expect(fleetRunsBadge({ ...input, codexPersonal: { usedPct } })!.personalPct).toBe(usedPct);
    const { lanes: _lanes, codexPersonal: _personal, ...old } = input;
    const badge = fleetRunsBadge(old)!;
    expect(badge.lanes).toEqual([]);
    expect(badge.personalPct).toBeNull();
    expect(Object.keys(badge)).not.toContain('lanes');
    expect(Object.keys(badge)).not.toContain('personalPct');
  });

  it('keeps ambiguous lane names distinct', () => {
    const input = withLane(fleetRunsFixture(), { lane: 'personal', running: 1, target: 1, held: false });
    expect(fleetRunsBadge(input)!.lanes[0].short).toBe('codex-personal');
  });
});
