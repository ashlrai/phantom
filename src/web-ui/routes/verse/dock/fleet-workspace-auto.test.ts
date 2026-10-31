import { beforeEach, describe, expect, it } from 'vitest';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { FLEET_PANES, STORAGE_KEY, fleetPanesPresent, readOptOut, shouldAutoOpen, writeOptOut } from './fleet-workspace-auto.js';

const empty: Pick<FleetRunsV1, 'workers' | 'leaders'> = { workers: [], leaders: [] };
const worker: FleetRunsV1['workers'][number] = { job: 'job', repo: 'repo', lane: 'lane', tier: 'tier', ageSeconds: null };
const base = { runs: empty, dockTabs: [], optOut: false, alreadyRanThisSession: false };

describe('fleet workspace auto-open', () => {
  beforeEach(() => localStorage.clear());

  it('requires a worker or a recent leader', () => {
    expect(shouldAutoOpen(base)).toBe(false);
    expect(shouldAutoOpen({ ...base, runs: null })).toBe(false);
    expect(shouldAutoOpen({ ...base, runs: { ...empty, workers: [worker] } })).toBe(true);
    for (const ageSeconds of [null, 1800, 3600]) {
      expect(shouldAutoOpen({ ...base, runs: { ...empty, leaders: [{ label: 'leader', ageSeconds }] } })).toBe(false);
    }
    for (const ageSeconds of [-1, 0, 1799]) {
      expect(shouldAutoOpen({ ...base, runs: { ...empty, leaders: [{ label: 'leader', ageSeconds }] } })).toBe(true);
    }
  });

  it('respects existing fleet tabs, opt-out, and the session guard', () => {
    const running = { ...base, runs: { ...empty, workers: [worker] } };
    expect(shouldAutoOpen({ ...running, dockTabs: ['terminal'] })).toBe(true);
    for (const id of FLEET_PANES) expect(shouldAutoOpen({ ...running, dockTabs: [id] })).toBe(false);
    expect(shouldAutoOpen({ ...running, optOut: true })).toBe(false);
    expect(shouldAutoOpen({ ...running, alreadyRanThisSession: true })).toBe(false);
  });

  it('stores and clears the opt-out', () => {
    expect(readOptOut(localStorage)).toBe(false);
    writeOptOut(localStorage, true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('off');
    expect(readOptOut(localStorage)).toBe(true);
    writeOptOut(localStorage, false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(readOptOut(localStorage)).toBe(false);
  });

  it('filters registered panes in workspace order', () => {
    expect(fleetPanesPresent(['fleet-inbox', 'terminal', 'fleet-hub', 'fleet-inbox', 'fleet-merges']))
      .toEqual(['fleet-hub', 'fleet-merges', 'fleet-inbox']);
    expect(fleetPanesPresent([])).toEqual([]);
  });
});
