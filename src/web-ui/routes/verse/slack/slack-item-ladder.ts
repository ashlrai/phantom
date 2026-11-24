/**
 * One row per Slack thread with its honest work state (RQ-PHX-SLACKITEMLADDER573).
 * Pure: no React, no I/O. The state comes from the shared classifier in
 * core/comms/work-state-contract.ts; this module only joins the reads.
 */
import { classifyWorkState, type WorkState } from '../../../../core/comms/work-state-contract.js';

export interface LadderThread { threadKey: string; label?: string; at: string }
export interface LadderClaim {
  threadKey: string; owner: string | null; claimId: string | null;
  /** Proof the owner is working (ISO). Absent means no live evidence. */
  liveAt?: string | null; at?: string | null;
}
export interface LadderReturn {
  claimId: string; result: 'VERIFIED' | 'BLOCKED';
  evidenceKind: 'pr' | 'tests' | 'artifact' | 'dependency';
  pr: number | null; head: string | null; evidence: string; at: string;
}
export interface LadderRow {
  threadLabel: string; firstSeenIso: string; state: WorkState; owner: string | 'unknown';
  evidence: string; asOf: string; stale: boolean;
}

const STALE_MS = 30 * 60_000;
const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

export function slackItemLadder(
  threads: readonly LadderThread[], claims: readonly LadderClaim[],
  returns: readonly LadderReturn[], now: Date,
): LadderRow[] {
  // Two deliveries of one thread collapse to one entry keyed by threadKey.
  const byThread = new Map<string, { label: string; first: number }>();
  for (const t of threads) {
    const at = ms(t.at);
    if (Number.isNaN(at) || t.threadKey === '') continue;
    const cur = byThread.get(t.threadKey);
    if (!cur) byThread.set(t.threadKey, { label: t.label ?? t.threadKey, first: at });
    else if (at < cur.first) cur.first = at;
  }
  const rows: LadderRow[] = [];
  for (const [key, t] of byThread) {
    const claim = claims.find(c => c.threadKey === key && c.claimId);
    const owned = claim ?? claims.find(c => c.threadKey === key);
    const mine = claim?.claimId ? returns.filter(r => r.claimId === claim.claimId) : [];
    const pr = mine.find(r => r.evidenceKind === 'pr' && r.pr !== null && r.head !== null);
    const tests = mine.some(r => r.result === 'VERIFIED' && r.evidenceKind === 'tests');
    const blocked = mine.find(r => r.result === 'BLOCKED');
    const firstIso = new Date(t.first).toISOString();
    const verdict = classifyWorkState({
      receivedAt: firstIso, source: 'slack',
      ...(owned?.owner ? { owner: owned.owner } : {}),
      ...(claim?.claimId ? { claimReceipt: claim.claimId } : {}),
      ...(claim?.liveAt ? { liveEvidenceAt: claim.liveAt } : {}),
      ...(blocked ? { blocker: blocked.evidence } : {}),
      ...(pr ? { artifact: { pr: pr.pr!, head: pr.head!, testsPassed: tests } } : {}),
    }, now);
    const times = [claim?.liveAt, claim?.at, ...mine.map(r => r.at)].map(ms).filter(n => !Number.isNaN(n));
    const newest = times.length ? Math.max(...times) : t.first;
    rows.push({
      threadLabel: t.label, firstSeenIso: firstIso, state: verdict.state,
      owner: owned?.owner || 'unknown',
      evidence: pr ? `PR #${pr.pr}` : claim?.claimId ?? 'none',
      asOf: new Date(newest).toISOString(),
      stale: now.getTime() - newest > STALE_MS,
    });
  }
  const rank = (r: LadderRow) => r.state === 'BLOCKED' ? 0 : r.state === 'RECEIVED' && r.owner === 'unknown' ? 1 : 2;
  return rows.sort((a, b) => rank(a) - rank(b) || a.firstSeenIso.localeCompare(b.firstSeenIso));
}
