/**
 * routes/approvals/pending-approvals-model.ts — pure view-model helpers for
 * the pending-approvals surface. No React, no fetch: everything here is
 * unit-testable without a DOM (same split as journal-model.ts).
 *
 * The backend contract (src/core/web/pending-approvals.ts) is already
 * value-blind; these helpers only decide how to PRESENT it — they never
 * add data the response did not carry.
 */
import type { PendingApprovalItem, PendingApprovalSource, PendingApprovalSourceQuality } from '../../data/api-types.js';

export const SOURCE_LABELS: Record<PendingApprovalSource, string> = {
  proposal: 'Proposal',
  draft: 'Email draft',
  'team-approval': 'Team approval',
};

/** Known parameter keys rendered before any extras, in consent-decision order. */
const PARAM_ORDER = ['repo', 'to', 'action', 'team', 'kind', 'origin', 'channel', 'source', 'requestedBy', 'engine', 'partial', 'digest', 'handoff'];

export function formatAge(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** 'patch' → 'Patch', 'email-draft' → 'Email draft', 'team:merge' → 'Team: merge'. */
export function kindLabel(kind: string): string {
  const [head, ...rest] = kind.split(':');
  const base = (head ?? kind).replace(/[-_]/g, ' ');
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  return rest.length > 0 ? `${label}: ${rest.join(':')}` : label;
}

export interface ParameterChip {
  key: string;
  value: string;
}

/** Ordered, display-ready parameter chips. Booleans read as yes/no; nulls are skipped. */
export function parameterChips(item: PendingApprovalItem, max = 8): ParameterChip[] {
  const entries = Object.entries(item.parameters).filter(([, v]) => v !== null && v !== undefined && v !== '');
  entries.sort(([a], [b]) => {
    const ia = PARAM_ORDER.indexOf(a);
    const ib = PARAM_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? PARAM_ORDER.length : ia) - (ib === -1 ? PARAM_ORDER.length : ib);
    return a.localeCompare(b);
  });
  return entries.slice(0, max).map(([key, value]) => ({
    key,
    value: typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value),
  }));
}

export function hiddenParameterCount(item: PendingApprovalItem, max = 8): number {
  const visible = Object.entries(item.parameters).filter(([, v]) => v !== null && v !== undefined && v !== '').length;
  return Math.max(0, visible - max);
}

/** Partial captures can be denied but the consent route refuses approve (mirrors ApprovalCard). */
export function isPartialCapture(item: PendingApprovalItem): boolean {
  return item.decide.mode === 'consent' && item.decide.partial === true;
}

/** A source only threatens the all-clear when it is degraded — 'missing' means legitimately empty. */
export function degradedSources(sources: Record<PendingApprovalSource, PendingApprovalSourceQuality>): PendingApprovalSource[] {
  return (Object.keys(sources) as PendingApprovalSource[]).filter((s) => sources[s].sourceState === 'degraded');
}

/** One-line summary of a terminal decide path for screen readers / hints. */
export function terminalHint(item: PendingApprovalItem): string | null {
  return item.decide.mode === 'terminal' ? item.decide.approveCommand : null;
}
