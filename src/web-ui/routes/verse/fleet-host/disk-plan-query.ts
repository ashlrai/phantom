import type { DiskPlanReportV1 } from '../../../../core/disk-maint/removal-plan.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function narrowDiskPlan(raw: unknown): DiskPlanReportV1 | null {
  if (!object(raw) || raw.schema !== 'disk.plan.v1' || typeof raw.sentence !== 'string' || !object(raw.runway) ||
      !object(raw.report) || !object(raw.report.plan) || typeof raw.report.plan.count !== 'number' ||
      !Array.isArray(raw.gaps)) return null;
  return raw as unknown as DiskPlanReportV1;
}

export const diskPlanQuery: QueryDef<DiskPlanReportV1 | null> = {
  key: 'verse-fleet-disk-plan',
  async fetch(signal) {
    try { return narrowDiskPlan(await apiGet<unknown>('/api/verse/fleet/memory/disk-plan', signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};
