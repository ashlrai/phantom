import type { LaneModelLane, LaneModelSnapshot } from '../fleet/lane-models.js';

export const VERSE_FLEET_LANE_MODELS_PATH = '/api/verse/fleet/runs/lane-models';
export interface FleetLaneModelsV1 {
  v: 1; generatedAt: string; source: 'ok' | 'unavailable'; reason: string | null;
  lanes: LaneModelLane[]; launches: number | null;
}

/** A missing model table must not look like a healthy empty fleet. */
export function toFleetLaneModelsV1(snapshot: LaneModelSnapshot | null, now: number): FleetLaneModelsV1 {
  const ok = snapshot !== null && snapshot.sources.models.state !== 'missing'
    && (snapshot.sources.models.state === 'healthy' || snapshot.sources.models.entries > 0);
  return {
    v: 1, generatedAt: new Date(now).toISOString(), source: ok ? 'ok' : 'unavailable',
    reason: ok ? null : 'Lane model table unavailable', lanes: ok ? snapshot.lanes : [],
    launches: snapshot?.sources.launches.state === 'healthy' ? snapshot.sources.launches.launches : null,
  };
}
