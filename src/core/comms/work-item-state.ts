/** Evidence-to-state rule for the Nov12 22:29 ET reporting contract: a work
 * item is RECEIVED, ASSIGNED, RUNNING, BLOCKED or VERIFIED only when
 * structured evidence says so. Free text ("routed", "dispatched") is never
 * evidence. Pure: no I/O, no clock (the caller passes `nowIso`). */
export type WorkItemState = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED';

export interface WorkItemEvidence {
  id: string;
  receivedAt?: string;
  owner?: string;
  claimReceipt?: string;
  runningEvidence?: { source: string; at: string };
  blocker?: { dependency: string; source: string; at: string };
  verified?: { pr?: number; head?: string; tests?: string; artifact?: string; source: string; at: string };
}

export interface WorkItemClassification { state: WorkItemState; asOf: string; source: string; missing: string[] }

/** Running evidence older than this no longer proves the item is running. */
export const RUNNING_FRESH_MS = 30 * 60 * 1000;
/** Evidence stamped further ahead of `nowIso` than this is not trusted. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const stamped = (v: unknown): v is string => text(v) && !Number.isNaN(Date.parse(v));

export function classifyWorkItem(e: WorkItemEvidence, nowIso: string): WorkItemClassification {
  const v = e.verified;
  if (v && text(v.source) && stamped(v.at)
    && ((typeof v.pr === 'number' && Number.isInteger(v.pr) && v.pr > 0 && text(v.head)) || text(v.tests) || text(v.artifact))) {
    return { state: 'VERIFIED', asOf: v.at, source: v.source, missing: [] };
  }
  const b = e.blocker;
  if (b && text(b.dependency) && b.dependency.trim().toLowerCase() !== 'unknown' && text(b.source) && stamped(b.at)) {
    return { state: 'BLOCKED', asOf: b.at, source: b.source, missing: [] };
  }
  const r = e.runningEvidence;
  const hasRunning = !!r && text(r.source) && stamped(r.at);
  const age = hasRunning ? Date.parse(nowIso) - Date.parse(r.at) : NaN;
  if (hasRunning && age <= RUNNING_FRESH_MS && age >= -FUTURE_SKEW_MS) {
    return { state: 'RUNNING', asOf: r.at, source: r.source, missing: [] };
  }

  const missing: string[] = [];
  if (!text(e.owner)) missing.push('named owner');
  if (!text(e.claimReceipt)) missing.push('durable claim receipt');
  const stale = hasRunning ? ['fresh running evidence'] : [];
  const asOf = stamped(e.receivedAt) ? e.receivedAt : 'unknown';
  if (missing.length === 0) return { state: 'ASSIGNED', asOf, source: `claim:${e.claimReceipt}`, missing: stale };
  return { state: 'RECEIVED', asOf, source: asOf === 'unknown' ? 'unknown' : 'receivedAt', missing: [...missing, ...stale] };
}
