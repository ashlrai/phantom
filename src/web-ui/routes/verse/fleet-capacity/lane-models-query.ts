import type { FleetLaneModelsV1 } from '../../../../core/verse/fleet-lane-models-contract.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const nullableText = (v: unknown) => v === null || text(v);
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
export function narrow(value: unknown): FleetLaneModelsV1 | null {
  if (!record(value) || value.v !== 1 || !date(value.generatedAt)
    || (value.source !== 'ok' && value.source !== 'unavailable') || !nullableText(value.reason)
    || !(value.launches === null || typeof value.launches === 'number' && Number.isSafeInteger(value.launches) && value.launches >= 0)
    || !Array.isArray(value.lanes) || !value.lanes.every((lane: unknown) => record(lane)
      && text(lane.lane) && text(lane.family) && typeof lane.mismatch === 'boolean'
      && Array.isArray(lane.tiers) && lane.tiers.every((row: unknown) => record(row) && text(row.tier) && nullableText(row.model) && nullableText(row.via))
      && (lane.lastLaunch === null || record(lane.lastLaunch) && text(lane.lastLaunch.lane)
        && nullableText(lane.lastLaunch.tier) && text(lane.lastLaunch.model)
        && (lane.lastLaunch.at === null || date(lane.lastLaunch.at))))) return null;
  return value as unknown as FleetLaneModelsV1;
}
export const laneModelsQuery: QueryDef<FleetLaneModelsV1 | null> = {
  key: 'verse-fleet-lane-models',
  async fetch(signal) {
    try {
      const data = narrow(await apiGet<unknown>('/api/verse/fleet/runs/lane-models', signal));
      if (!data) throw new Error('Invalid lane models response.');
      return data;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
