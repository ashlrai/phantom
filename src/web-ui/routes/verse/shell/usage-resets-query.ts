import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface UsageResetRow {
  lane: string; held: boolean; heldReason: string | null; heldUntil: string | null;
  holdSince: string | null; heldBy: 'autobackoff' | 'manual' | null;
  usedPct: number | null; readingAsOf: string | null; resetAt: string | null;
  state: 'reset-detected' | 'hold-expired' | 'consistent' | 'stale-reading' | 'no-reading' | 'manual-hold' | 'open';
  releasable: boolean; tell: string;
}
export interface UsageResets {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'degraded' | 'missing'; rows: UsageResetRow[];
}

const nullableString = (value: unknown) => value === null || typeof value === 'string';
const states = ['reset-detected', 'hold-expired', 'consistent', 'stale-reading', 'no-reading', 'manual-hold', 'open'];

export function narrowUsageResets(raw: unknown): UsageResets | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || typeof value.generatedAt !== 'string' ||
    !['healthy', 'degraded', 'missing'].includes(value.sourceState as string) || !Array.isArray(value.rows)) return null;
  if (!value.rows.every((row: unknown) => {
    if (!row || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    return typeof r.lane === 'string' && r.lane.length > 0 && typeof r.held === 'boolean' &&
      nullableString(r.heldReason) && nullableString(r.heldUntil) && nullableString(r.holdSince) &&
      (r.heldBy === null || r.heldBy === 'autobackoff' || r.heldBy === 'manual') &&
      (r.usedPct === null || (typeof r.usedPct === 'number' && Number.isFinite(r.usedPct))) &&
      nullableString(r.readingAsOf) && nullableString(r.resetAt) && states.includes(r.state as string) &&
      typeof r.releasable === 'boolean' && typeof r.tell === 'string';
  })) return null;
  return raw as UsageResets;
}

export const usageResetsQuery: QueryDef<UsageResets | null> = {
  key: 'verse-usage-resets',
  fetch: async signal => narrowUsageResets(await apiGet<unknown>('/api/verse/leader/resources/resets', signal)),
};
