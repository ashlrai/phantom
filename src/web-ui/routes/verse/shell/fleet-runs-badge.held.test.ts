import { describe, expect, it } from 'vitest';
import { describeFleetRuns, fleetRunsBadge, fleetRunsTone } from './fleet-runs-badge.js';

const response = { v: 1, workers: [{ job: 'a' }], leaders: [], mergesLastHour: { count: 7 }, switches: [] };

describe('held fleet lanes', () => {
  it('defaults missing fields for older servers and rejects malformed fields', () => {
    const badge = fleetRunsBadge(response)!;
    expect(badge.paused).toBe(false);
    expect(badge.heldLanes).toEqual([]);
    expect(fleetRunsBadge({ ...response, paused: 'yes' })).toBeNull();
    expect(fleetRunsBadge({ ...response, lanes: [{ lane: 'x' }] })).toBeNull();
  });

  it('sorts held names and only shortens unambiguous codex names', () => {
    const badge = fleetRunsBadge({ ...response, paused: true, lanes: [
      { lane: 'codex-personal', held: true }, { lane: 'codex-cmp', held: true },
      { lane: 'claude', held: true }, { lane: 'devin', held: false },
      { lane: 'codex-devin', held: true },
    ] })!;
    expect(badge.heldLanes).toEqual(['claude', 'cmp', 'codex-devin', 'personal']);
    expect(fleetRunsTone(badge)).toBe('warning');
    expect(describeFleetRuns(badge)).toBe('1 worker running · 7 merged last hour · paused · held: claude, cmp, codex-devin, personal');
    expect(fleetRunsTone({ ...badge, paused: false })).toBe('warning');
    expect(fleetRunsTone({ ...badge, heldLanes: [] })).toBe('warning');
  });
});
