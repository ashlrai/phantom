import type { HostLoadReport } from '../../../../core/fleet/host-load.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const item = (raw: unknown): boolean => {
  const row = raw as Record<string, unknown> | null;
  return !!row && typeof row === 'object' && typeof row.name === 'string' && count(row.cpuPercent) && count(row.rssMb) && count(row.processes);
};

/** Accepts only a well-formed host.load.v1 report; anything else is treated as no reading. */
export function narrowHostLoad(raw: unknown): HostLoadReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 'host.load.v1' || r.version !== 1 || typeof r.summary !== 'string' || !['known', 'partial', 'unknown'].includes(String(r.state)) ||
      !count(r.cpuPercent) || !Array.isArray(r.groups) || r.groups.length > 16 || !Array.isArray(r.gaps) || !r.gaps.every(gap => typeof gap === 'string')) return null;
  for (const group of r.groups as Array<Record<string, unknown>>) {
    if (!item(group) || typeof group.id !== 'string' || !(group.loadPoints === null || count(group.loadPoints)) ||
        !Array.isArray(group.items) || !group.items.every(item)) return null;
  }
  return raw as HostLoadReport;
}

export const hostLoadQuery: QueryDef<HostLoadReport | null> = {
  key: 'verse-fleet-host-load',
  async fetch(signal) {
    try { return narrowHostLoad(await apiGet<unknown>('/api/verse/fleet/memory/host-load', signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};
