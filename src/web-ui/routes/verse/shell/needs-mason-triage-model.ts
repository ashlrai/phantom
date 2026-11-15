/**
 * Pure grouping for the Needs-you drawer's "Needs Mason" rows: lines that hit
 * one of the four hard limits stay individual, the rest can be resolved in one
 * batch. The classification itself lives in core/fleet (a type-only import
 * chain, so it is safe in the browser bundle).
 */
import { triageNeedsItems, type HardLimit } from '../../../../core/fleet/needs-mason-triage.js';

/** Same reply text `ashlr fleet needs-triage --apply` uses (a test pins them together). */
export const AUTO_RESOLVE_REPLY = 'auto-resolved: outside the four hard limits (t1637u)';

export interface NeedsMasonTriageRow { id: string; text: string }
export interface HardLimitRow extends NeedsMasonTriageRow { limit: HardLimit; reason: string }

export function groupNeedsMasonRows(rows: NeedsMasonTriageRow[]): { hardLimit: HardLimitRow[]; auto: NeedsMasonTriageRow[] } {
  return triageNeedsItems(rows);
}

export function batchResolveSummary(counts: { ok: number; duplicate: number; failed: number }): string {
  return `Resolved ${counts.ok}, ${counts.duplicate} already resolved, ${counts.failed} failed`;
}

export function hardLimitChip(reason: string): string {
  return `Hard limit: ${reason}`;
}
