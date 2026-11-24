/**
 * Read-only diagnosis of where one PR is in the merge pipeline: per-stage
 * timestamps, elapsed time, whether the current stage is stalled, and what
 * happens next on its own. Advice only: nothing here merges, requeues or
 * skips a required check, review or merge-queue rule.
 */
import type { MergeQueueStatus } from './merge-queue-status.js';

export type MergeWaitState = 'not_queued' | 'queued' | 'required_checks' | 'conflict' | 'review' | 'blocked' | 'merged' | 'closed' | 'unknown';
export type MergeWaitAction = 'none' | 'enqueue' | 'merge_queue' | 'required_checks' | 'recut' | 'merge_retry' | 'person';

export interface MergeStageTimes { opened_at: string | null; queued_at: string | null; checks_passed_at: string | null; merged_at: string | null }
export interface MergeWaitNext {
  action: MergeWaitAction;
  /** True when an existing loop or the merge queue acts without a person. */
  automatic: boolean;
  note: string;
}
export interface MergeWaitDiagnosis {
  state: MergeWaitState;
  stage_times: MergeStageTimes;
  /** Opened to merge (or to now while open); null when a boundary is missing, repeated or reversed. */
  elapsed_s: number | null;
  /** Age of the current stage; null for terminal or unmeasurable PRs. */
  stage_waiting_s: number | null;
  /** True once the current stage has lasted `stalled_after_s`; null when unmeasurable. */
  stalled: boolean | null;
  diagnosis: string;
  next: MergeWaitNext;
}

export interface MergeWaitInput {
  times: { opened?: number; queued?: number; checks_passed?: number; merged?: number };
  closed: boolean;
  status: MergeQueueStatus;
  /** A dropped auto-merge that `phm fleet merge-retry` may re-arm. */
  retryable: boolean;
  now: number;
  stalledAfter: number;
}

const iso = (t: number | undefined) => t === undefined ? null : new Date(t).toISOString();
const span = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;

const STATE_OF: Record<MergeQueueStatus['stage'], MergeWaitState> = {
  queue: 'queued', required_checks: 'required_checks', conflict: 'conflict', review: 'review', other: 'blocked',
  unknown: 'unknown', merged: 'merged', closed: 'closed',
};
const LABEL: Record<MergeWaitState, string> = {
  not_queued: 'not yet queued', queued: 'in the merge queue', required_checks: 'waiting on required checks', conflict: 'blocked by a conflict',
  review: 'waiting on review', blocked: 'blocked', merged: 'merged', closed: 'closed', unknown: 'in an unknown state',
};
const NEXT: Record<MergeWaitState, MergeWaitNext> = {
  not_queued: { action: 'enqueue', automatic: true, note: 'The merge queue loop enqueues it once it is green and mergeable.' },
  queued: { action: 'merge_queue', automatic: true, note: 'The merge queue merges it after its merge-group checks pass.' },
  required_checks: { action: 'required_checks', automatic: true, note: 'Auto-merge proceeds when every required check passes; none are skipped.' },
  conflict: { action: 'recut', automatic: true, note: 'The recut loop requests a recut; a person resolves it after three requests.' },
  review: { action: 'person', automatic: false, note: 'Needs the required review; nothing proceeds automatically.' },
  blocked: { action: 'person', automatic: false, note: 'Inspect the recorded blocker; nothing proceeds automatically.' },
  merged: { action: 'none', automatic: false, note: 'Merged.' },
  closed: { action: 'none', automatic: false, note: 'Closed without merging.' },
  unknown: { action: 'person', automatic: false, note: 'Observations are missing or contradictory; check the PR directly.' },
};

export function diagnoseMergeWait(input: MergeWaitInput): MergeWaitDiagnosis {
  const { times, status, now, stalledAfter } = input;
  const terminal = input.closed || status.stage === 'merged' || status.stage === 'closed';
  let state: MergeWaitState = input.closed && status.stage !== 'merged' ? 'closed' : STATE_OF[status.stage];
  if (state === 'unknown' && times.opened !== undefined && times.queued === undefined && times.merged === undefined && !input.closed) state = 'not_queued';
  const bounds = [times.opened, times.queued, times.checks_passed, times.merged].filter((t): t is number => t !== undefined);
  const ordered = bounds.every((t, i) => i === 0 || t >= bounds[i - 1]!);
  const end = times.merged ?? (terminal ? undefined : now);
  const elapsed = ordered && times.opened !== undefined && end !== undefined && end >= times.opened ? Math.round((end - times.opened) / 1000) : null;
  // Not-queued waits run from open; every other stage age comes from the observed status.
  const waiting = terminal ? null : state === 'not_queued' ? elapsed : status.waiting_s === null ? null : Math.round(status.waiting_s);
  const stalled = terminal ? false : waiting === null ? null : waiting >= stalledAfter;
  const retry = !terminal && input.retryable;
  const next = retry ? { action: 'merge_retry' as const, automatic: true, note: 'Auto-merge was dropped; phm fleet merge-retry re-arms it within its retry cap.' } : NEXT[state];
  const diagnosis = terminal ? `${LABEL[state][0]!.toUpperCase()}${LABEL[state].slice(1)}${elapsed === null || state !== 'merged' ? '' : ` after ${span(elapsed)}`}.`
    : waiting === null ? `PR is ${LABEL[state]}; the wait cannot be measured from the recorded times.`
      : `PR is ${LABEL[state]} for ${span(waiting)}${stalled ? `, past the ${span(stalledAfter)} stall limit. ${stalledAdvice(state)}` : '.'}`;
  return { state, stage_times: { opened_at: iso(times.opened), queued_at: iso(times.queued), checks_passed_at: iso(times.checks_passed), merged_at: iso(times.merged) },
    elapsed_s: elapsed, stage_waiting_s: waiting, stalled, diagnosis, next };
}

function stalledAdvice(state: MergeWaitState): string {
  switch (state) {
    case 'required_checks': return 'Inspect pending or failed required checks; keep them enabled.';
    case 'queued': return 'Inspect merge-group checks and queue membership.';
    case 'conflict': return 'Check that a recut was requested.';
    case 'review': return 'Obtain the required review.';
    case 'not_queued': return 'Check that auto-merge is armed and the PR is green.';
    default: return 'Inspect the PR and its queue state.';
  }
}
