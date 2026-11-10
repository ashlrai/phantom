import { conflicted, mergeAge, type MergeAgeInput, type MergeAgePr } from './merge-age.js';
import { recutRequest, type MergeRecutRequest } from '../merge-eta.js';

/** After this many recorded recut requests for one PR, a person should look at it. */
export const MAX_QUEUE_AGE_RECUTS = 3;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

export interface MergeQueueAgePr extends MergeAgePr {
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
}
export interface MergeQueueAgeInput extends MergeAgeInput {
  prs: MergeQueueAgePr[];
}

/**
 * The one recut a conflicting queue entry enqueues through the existing
 * merge-queue recut path (the recut loop / `phm fleet merge-recover`). `key`
 * is the shared idempotency token from merge-eta.ts: the same conflicting head
 * observed again yields the same key, so a deduping consumer enqueues once —
 * never twice — and a moved head mints a new key.
 */
export interface MergeQueueRecut {
  number: number;
  repo: string;
  head_sha: string;
  /** Queue dwell of the conflicting entry; null when unmeasured. */
  waiting_s: number | null;
  /** When the conflict surfaced (the PR's updatedAt); null when unrecorded. */
  since: string | null;
  recut: MergeRecutRequest;
}
export type MergeQueueRecutBlock =
  'ambiguous' | 'no-repo' | 'no-head' | 'already-requested' | 'too-many-recuts';
export interface MergeQueueBlockedConflict {
  number: number;
  reason: MergeQueueRecutBlock;
}

/** Only active queue entries contribute to current merge latency. */
export function mergeQueueAge(input: MergeQueueAgeInput, now = Date.now()) {
  const inactive = new Set(input.prs.filter(pr => pr.state === 'MERGED' || pr.state === 'CLOSED').map(pr => pr.number));
  const queue = input.queue.filter(entry => !inactive.has(entry.number));
  const report = mergeAge({ prs: input.prs, queue, repo: input.repo }, now);
  const byNumber = new Map<number, (typeof report.entries)[number]>();
  for (const row of report.entries) if (!byNumber.has(row.number)) byNumber.set(row.number, row);
  const retryable: MergeQueueRecut[] = [];
  const blocked: MergeQueueBlockedConflict[] = [];
  const blockedNumbers = new Set<number>();
  const block = (number: number, reason: MergeQueueRecutBlock) => {
    if (!blockedNumbers.has(number)) { blockedNumbers.add(number); blocked.push({ number, reason }); }
  };
  for (const entry of queue) {
    const matches = input.prs.filter(pr => pr.number === entry.number);
    if (!matches.some(conflicted)) continue;
    const pr = matches.length === 1 ? matches[0] : undefined;
    if (queue.filter(row => row.number === entry.number).length !== 1 || pr === undefined) {
      block(entry.number, 'ambiguous');
      continue;
    }
    const repo = [pr.repo, input.repo].find(slug => typeof slug === 'string' && REPO_SLUG.test(slug));
    const request = repo === undefined ? null : recutRequest(repo, entry.number, pr.headSha ?? null);
    if (repo === undefined) block(entry.number, 'no-repo');
    else if (request === null) block(entry.number, 'no-head');
    else if ((pr.recutRequests ?? 0) >= MAX_QUEUE_AGE_RECUTS) block(entry.number, 'too-many-recuts');
    else if (typeof pr.lastRecutHead === 'string' && pr.lastRecutHead.length >= 7
      && request.headSha.startsWith(pr.lastRecutHead.toLowerCase().slice(0, 40))) {
      block(entry.number, 'already-requested');
    } else {
      const row = byNumber.get(entry.number);
      retryable.push({ number: entry.number, repo: request.repo, head_sha: request.headSha,
        waiting_s: row?.ageSeconds ?? null,
        since: row?.causes.find(cause => cause.code === 'conflicts')?.since ?? null, recut: request });
    }
  }
  return { ...report,
    schema: 'fleet.merge-queue-age.v1' as const,
    retryable_conflicts: retryable.sort((a, b) => (b.waiting_s ?? -1) - (a.waiting_s ?? -1) || a.number - b.number),
    blocked_conflicts: blocked.sort((a, b) => a.number - b.number) };
}
