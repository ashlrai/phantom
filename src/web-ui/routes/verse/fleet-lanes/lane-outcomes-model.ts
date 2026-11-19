import type { JobOutcomesReport } from '../../../../core/fleet/job-outcomes.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Checks only what the lane card reads: the schema id and each lane's one-line summary. */
export function isJobOutcomesReport(value: unknown): value is JobOutcomesReport {
  return record(value) && value.schema === 'fleet.job-outcomes.v1' && typeof value.known === 'boolean' && Array.isArray(value.lanes)
    && value.lanes.every(lane => record(lane) && typeof lane.lane === 'string' && typeof lane.summary === 'string');
}

/** The lane's one-line yield summary for the last day, e.g. "zai: 1 merged of 56; most empty: task already on master". Null when unknown or the lane ran nothing. */
export function laneOutcomeLine(lane: string, report: JobOutcomesReport | null | undefined): string | null {
  if (!report?.known) return null;
  return report.lanes.find(row => row.lane === lane)?.summary ?? null;
}
