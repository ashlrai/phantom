import { describe, expect, it } from 'vitest';
import { fleetOrgMap } from '../src/core/fleet/org-map.js';
import type { FleetLiveSnapshotV1, FleetLiveRun } from '../src/core/fleet/fleet-types.js';

function run(id: string, lane: FleetLiveRun['lane'], overrides: Partial<FleetLiveRun> = {}): FleetLiveRun {
  return { id, taskId: null, repo: 'phantom', title: id, lane, seatId: null, engine: null, model: null,
    phase: 'producing', startedAt: null, phaseStartedAt: null, endedAt: null, outcome: null, prNumber: null, hold: null, seatDecision: null, ...overrides };
}

describe('fleet map', () => {
  it('groups five active jobs under three lanes and excludes past and waiting work', () => {
    const snapshot = { generatedAt: '2026-11-09T00:00:00Z', state: 'running',
      lanes: ['codex', 'claude-cli', 'local'].map(lane => ({ lane, slots: 2, busy: 1, capReason: null })),
      runs: [run('one', 'codex'), run('two', 'codex'), run('three', 'claude-cli'), run('four', 'local'), run('five', 'local'),
        run('waiting', 'codex', { phase: 'queued' }), run('finished', 'codex', { outcome: 'merged' })] } as FleetLiveSnapshotV1;
    const map = fleetOrgMap(snapshot);
    expect(map.leader).toEqual({ name: 'Leader', status: 'running' });
    expect(map.lanes?.map(lane => [lane.provider, lane.jobs.map(job => job.id)])).toEqual([
      ['Codex', ['one', 'two']], ['Claude', ['three']], ['Local', ['four', 'five']],
    ]);
  });
  it('preserves unknown state and unmatched lanes', () => {
    expect(fleetOrgMap(null).lanes).toBeNull();
    const snapshot = { generatedAt: 'now', state: 'dark', lanes: [], runs: [run('unknown', null)] } as unknown as FleetLiveSnapshotV1;
    expect(fleetOrgMap(snapshot).lanes?.[0]).toMatchObject({ id: null, provider: null, jobs: [{ id: 'unknown' }] });
  });
});
