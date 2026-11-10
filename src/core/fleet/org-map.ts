import type { FleetLiveSnapshotV1 } from './fleet-types.js';

/** A read-only view of the live snapshot; null means the source is unavailable. */
export function fleetOrgMap(snapshot: FleetLiveSnapshotV1 | null) {
  if (!snapshot) return { schema: 'fleet.map.v1' as const, generatedAt: null, leader: { name: 'Leader', status: null }, lanes: null };
  const active = snapshot.runs.filter(run => !run.endedAt && !run.outcome && run.phase !== 'queued' && run.phase !== 'parked');
  const laneNames = [...new Set([...snapshot.lanes.map(lane => lane.lane), ...active.map(run => run.lane)])];
  return {
    schema: 'fleet.map.v1' as const,
    generatedAt: snapshot.generatedAt,
    leader: { name: 'Leader', status: snapshot.state },
    lanes: laneNames.map(lane => ({
      id: lane,
      provider: lane === null ? null : ({ local: 'Local', 'grok-cli': 'Grok', 'claude-cli': 'Claude', codex: 'Codex', 'devin-cli': 'Devin' }[lane] ?? lane),
      jobs: active.filter(run => run.lane === lane).map(run => ({ id: run.id, title: run.title || null, repo: run.repo || null, phase: run.phase })),
    })),
  };
}
