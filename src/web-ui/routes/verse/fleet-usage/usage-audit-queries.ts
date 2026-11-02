import type { UsageMotionClassification } from '../../../../core/fleet/usage-motion-audit.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface AuditLane {
  lane: string;
  classification: UsageMotionClassification;
  pctUsedFirst: number | null;
  pctUsedLast: number | null;
  pctUsedDelta: number | null;
  observedMinutes: number | null;
  reason: string;
  nextAction: string;
}
export interface UsageAuditView {
  lanes: AuditLane[];
  incidents: number;
  sources: { usageJournal: { state: 'healthy' | 'missing' | 'degraded' } };
}
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const nullableNumber = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));
const classes: readonly string[] = ['incident', 'moving', 'idle', 'reset-observed', 'insufficient-evidence'];
export function narrowUsageAudit(x: unknown): UsageAuditView | null {
  if (!record(x) || x.v !== 1 || !record(x.audit)) return null;
  const a = x.audit;
  if (!Array.isArray(a.lanes) || !a.lanes.every(l => record(l) && typeof l.lane === 'string'
    && typeof l.classification === 'string' && classes.includes(l.classification)
    && nullableNumber(l.pctUsedFirst) && nullableNumber(l.pctUsedLast) && nullableNumber(l.pctUsedDelta)
    && nullableNumber(l.observedMinutes) && typeof l.reason === 'string' && typeof l.nextAction === 'string')
    || typeof a.incidents !== 'number' || !Number.isSafeInteger(a.incidents) || a.incidents < 0
    || !record(a.sources) || !record(a.sources.usageJournal)
    || !['healthy', 'missing', 'degraded'].includes(a.sources.usageJournal.state as string)) return null;
  return a as unknown as UsageAuditView;
}

// A missing route stays missing for this page lifetime, including remounts.
let missing: ApiError | null = null;
export const usageAuditQuery: QueryDef<UsageAuditView | null> = {
  key: 'verse-fleet-usage-audit',
  fetch: async signal => {
    if (missing) throw missing;
    try { return narrowUsageAudit(await apiGet<unknown>('/api/verse/fleet/usage-audit', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};
