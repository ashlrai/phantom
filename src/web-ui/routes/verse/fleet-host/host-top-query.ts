import type { HostReportV1 } from '../../../../core/fleet/host-top.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const HOST_TOP_PATH = '/api/verse/fleet/host';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const maybe = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value));
const groups = (value: unknown): boolean => value === null || (Array.isArray(value) && value.every(g => object(g) &&
  typeof g.label === 'string' && typeof g.fleet === 'boolean' && [g.processes, g.cpuPercent, g.rssBytes].every(n => typeof n === 'number' && Number.isFinite(n))));

/** phantom.host.v1 only; any other shape is treated as no reading rather than half-rendered. */
export function narrowHostTop(raw: unknown): HostReportV1 | null {
  if (!object(raw) || raw.schema !== 'phantom.host.v1' || raw.version !== 1 || typeof raw.generatedAt !== 'string') return null;
  const { load, memory, processes: p } = raw;
  if (!object(load) || !object(memory) || !object(p) || (p.state !== 'known' && p.state !== 'unknown')) return null;
  if (![load.load1, load.load5, load.load15, load.cpuCount, memory.freePercent, memory.swapGb,
    p.count, p.cpuPercent, p.fleetCpuPercent, p.otherCpuPercent, p.fleetShare, raw.orphanCount].every(maybe)) return null;
  if (!groups(raw.topCpu) || !groups(raw.topRss)) return null;
  if (!(raw.orphans === null || (Array.isArray(raw.orphans) && raw.orphans.every(o => object(o) && typeof o.pid === 'number' &&
    typeof o.name === 'string' && typeof o.job === 'string' && typeof o.reason === 'string' && maybe(o.ageSeconds))))) return null;
  return raw as unknown as HostReportV1;
}

export const hostTopQuery: QueryDef<HostReportV1 | null> = {
  key: 'verse-fleet-host',
  async fetch(signal) {
    try { return narrowHostTop(await apiGet<unknown>(HOST_TOP_PATH, signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
