import type { DiskForecast } from '../../../../core/fleet/disk-forecast.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export function narrowDiskForecast(raw: unknown): DiskForecast | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const response = raw as Record<string, unknown>;
  if (response.v !== 1 || !response.forecast || typeof response.forecast !== 'object' || Array.isArray(response.forecast)) return null;
  const f = response.forecast as Record<string, unknown>;
  if (f.schema !== 'fleet.disk-forecast.v1' || f.thresholdGb !== 150 || !['projected', 'reached', 'not-falling', 'unknown'].includes(String(f.status)) ||
      typeof f.samples !== 'number' || !Number.isSafeInteger(f.samples) || f.samples < 0) return null;
  for (const key of ['freeGb', 'consumptionGbPerHour', 'hoursUntilThreshold', 'launchedJobs']) {
    if (f[key] !== null && (typeof f[key] !== 'number' || !Number.isFinite(f[key]))) return null;
  }
  for (const key of ['observedFrom', 'observedTo', 'crossingAt']) {
    if (f[key] !== null && (typeof f[key] !== 'string' || !Number.isFinite(Date.parse(f[key] as string)))) return null;
  }
  if (f.status === 'projected' && (typeof f.hoursUntilThreshold !== 'number' || f.hoursUntilThreshold < 0 || typeof f.consumptionGbPerHour !== 'number' || f.consumptionGbPerHour <= 0 || typeof f.crossingAt !== 'string')) return null;
  return f as unknown as DiskForecast;
}

export const diskForecastQuery: QueryDef<DiskForecast | null> = {
  key: 'verse-fleet-disk-forecast',
  async fetch(signal) {
    try { return narrowDiskForecast(await apiGet<unknown>('/api/verse/fleet/memory/disk-forecast', signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};
