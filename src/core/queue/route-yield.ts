/**
 * Adds measured job yield to route sources, for the runway policy in
 * decision-candidates.ts. Kept apart from that module so the job ledger reader
 * stays out of the Tier-1 import closure (routing/ is a Tier-1 root directory).
 */
import { join } from 'node:path';
import { readJobYieldParts } from '../fleet/metrics-series.js';
import { capacityRunwayState, type RouteSources } from '../routing/decision-candidates.js';
import { validResetCalendarPool } from '../routing/reset-pressure.js';
import { isQueueRecord } from './schema.js';

/** True when some capacity entry runs dry before its reset at the measured burn. */
export function anyPoolStarves(capacity: unknown, nowMs: number): boolean {
  if (!isQueueRecord(capacity)) return false;
  return Object.entries(capacity).some(([pool, raw]) => {
    const entry = { ...(isQueueRecord(raw) ? raw : {}), pool };
    return validResetCalendarPool(entry) && capacityRunwayState(entry, nowMs) === 'starve';
  });
}

/**
 * The 24 h merged-per-launch by job kind from `<root>/metrics/jobs.jsonl`, read only
 * when a pool starves (otherwise the policy needs no yield). An unreadable ledger
 * leaves `familyYield` unset: filler then stays off the starving pool.
 */
export async function withRunwayYield(root: string, sources: RouteSources, nowMs = Date.now()): Promise<RouteSources> {
  if (!anyPoolStarves(sources.capacity, nowMs)) return sources;
  const { report } = await readJobYieldParts(join(root, 'metrics', 'jobs.jsonl'), 24, nowMs);
  return report.known ? { ...sources, familyYield: Object.fromEntries(report.families.map(row => [row.family, row.merged_per_launch])) } : sources;
}
