/**
 * Host auto-merge cancellation for the canary (design-autonomy-canary.md
 * section 4.3, PR plan step 4). NOT wired: nothing calls this yet, enforce stays
 * unsupported and `hostCancellationProven` stays false. Its tests are the
 * proof the enforce ladder needs before anyone may consider flipping it.
 *
 * Cancellation counts as confirmed only on positive evidence read back from
 * the host after `gh pr merge --disable-auto`: the PR is still open and
 * unmerged, the head is the one we expected, and `autoMergeRequest` is
 * explicitly absent. Anything else (exec failure, unreadable view, auto-merge
 * still present or unknown, moved head) is `not-confirmed`. A PR that merged
 * anyway is reported as `merged` so the caller can start rollback instead.
 */
import type { PrView } from '../integrations/github.js';

export type CancelExec = (args: readonly string[]) => { ok: boolean };
export type CancelView = () => PrView | null;

export type HostCancellationResult =
  | { outcome: 'cancelled-confirmed'; reads: number }
  | { outcome: 'closed-unmerged'; reads: number }
  | { outcome: 'merged'; mergeCommitOid: string | null; reads: number }
  | { outcome: 'not-confirmed'; reason: 'disable-failed' | 'view-unavailable' | 'auto-merge-still-present' | 'auto-merge-unknown' | 'head-moved' | 'state-unknown'; reads: number };

export const HOST_CANCELLATION_MAX_READS = 3;

export function cancelHostAutoMerge(
  target: { repo: string; number: number; expectedHeadOid: string },
  deps: { exec: CancelExec; view: CancelView; maxReads?: number },
): HostCancellationResult {
  const maxReads = Math.max(1, Math.min(deps.maxReads ?? HOST_CANCELLATION_MAX_READS, 10));
  let disabled = false;
  try {
    disabled = deps.exec(['pr', 'merge', String(target.number), '--repo', target.repo, '--disable-auto']).ok === true;
  } catch {
    disabled = false;
  }
  let last: HostCancellationResult = { outcome: 'not-confirmed', reason: 'view-unavailable', reads: 0 };
  for (let reads = 1; reads <= maxReads; reads++) {
    let v: PrView | null = null;
    try { v = deps.view(); } catch { v = null; }
    if (!v) { last = { outcome: 'not-confirmed', reason: 'view-unavailable', reads }; continue; }
    // A merge wins over everything: the host merged, cancellation failed.
    if (typeof v.mergedAt === 'string' || v.state === 'MERGED') {
      return { outcome: 'merged', mergeCommitOid: v.mergeCommitOid ?? null, reads };
    }
    if (v.state === 'CLOSED' && v.closed === true) return { outcome: 'closed-unmerged', reads };
    if (v.state !== 'OPEN') { last = { outcome: 'not-confirmed', reason: 'state-unknown', reads }; continue; }
    if (v.headRefOid !== target.expectedHeadOid) return { outcome: 'not-confirmed', reason: 'head-moved', reads };
    if (v.autoMergeRequest.kind === 'unknown') { last = { outcome: 'not-confirmed', reason: 'auto-merge-unknown', reads }; continue; }
    if (v.autoMergeRequest.kind === 'present') { last = { outcome: 'not-confirmed', reason: 'auto-merge-still-present', reads }; continue; }
    // Absent auto-merge on an open PR is only trusted after our disable call succeeded.
    if (!disabled) return { outcome: 'not-confirmed', reason: 'disable-failed', reads };
    return { outcome: 'cancelled-confirmed', reads };
  }
  return last;
}
