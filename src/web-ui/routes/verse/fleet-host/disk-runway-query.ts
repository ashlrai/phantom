import type { FleetDiskRunwayResponseV1 } from '../../../../core/verse/fleet-disk-runway-api.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableNumber = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value));
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';

export function narrowDiskRunway(raw: unknown): FleetDiskRunwayResponseV1 | null {
  if (!object(raw) || raw.schema !== 'fleet.disk-runway.v1' || !object(raw.forecast) || !object(raw.lines)) return null;
  const { forecast, lines } = raw;
  if (!['projected', 'reached', 'not-falling', 'unknown'].includes(forecast.status as string)) return null;
  if (!nullableNumber(forecast.freeGb) || !nullableNumber(forecast.consumptionGbPerHour) ||
      !nullableString(forecast.observedFrom) || !nullableString(forecast.observedTo)) return null;
  if (typeof lines.reuseOnlyGb !== 'number' || typeof lines.hardStopGb !== 'number') return null;
  if (!nullableNumber(raw.hoursToReuseOnly) || !nullableNumber(raw.hoursToHardStop)) return null;
  return raw as unknown as FleetDiskRunwayResponseV1;
}

export const diskRunwayQuery: QueryDef<FleetDiskRunwayResponseV1 | null> = {
  key: 'verse-fleet-disk-runway',
  async fetch(signal) {
    try { return narrowDiskRunway(await apiGet<unknown>('/api/verse/fleet/disk-runway', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
