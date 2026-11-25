import { conflicted, mergeAge, type MergeAgeEntry, type MergeAgeInput, type MergeAgePr } from './merge-age.js';
import { recutRequest, type MergeRecutRequest } from '../merge-eta.js';
import type { PreparationResult } from './merge-queue-prep.js';
import { currentQueueChecks, fullQueueSha, preparationStall, type QueueRevision } from './merge-queue-status.js';

/** After this many recorded recut requests for one PR, a person should look at it. */
export const MAX_QUEUE_AGE_RECUTS = 3;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

export interface MergeQueueAgePr extends MergeAgePr {
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
}
export interface MergeQueueAgeInput extends MergeAgeInput {
  prs: MergeQueueAgePr[];
  queue: (MergeAgeEntry & { revision?: QueueRevision; checksRevision?: QueueRevision })[];
  preparations?: readonly PreparationResult[];
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
  const pinnedSnapshot = input.preparations !== undefined
    || queue.some(entry => entry.revision !== undefined || entry.checksRevision !== undefined);
  const observations = pinnedSnapshot ? queue.map(entry => {
    const matches = input.prs.filter(pr => pr.number === entry.number);
    const pr = matches.length === 1 ? matches[0] : undefined;
    const revision = entry.revision;
    const repo = pr?.repo ?? input.repo;
    const pinned = revision && typeof repo === 'string' && REPO_SLUG.test(repo) && revision.repo === repo
      && fullQueueSha(revision.headSha) && revision.headSha === pr?.headSha && fullQueueSha(revision.baseSha)
      && queue.filter(row => row.number === entry.number).length === 1;
    const preps = Array.isArray(input.preparations) ? input.preparations.filter(p =>
      p?.repo === repo && p?.number === entry.number && p?.headSha === revision?.headSha) : [];
    const checkPinned = pinned && currentQueueChecks(revision, entry.checksRevision);
    const prep = preps.length === 1 ? preps[0] : undefined;
    const prepStall = pinned ? preparationStall(revision, prep) : 'unknown';
    return { entry: { ...entry, requiredChecks: checkPinned ? entry.requiredChecks : undefined },
      stall: prepStall !== 'unknown' ? prepStall
        : checkPinned && entry.requiredChecks?.some(c => c.status === 'failure') ? 'check_failure' as const : 'unknown' as const,
      stallEvidence: pinned ? { repo, headSha: revision.headSha, baseSha: revision.baseSha,
        preparedBaseSha: prepStall === 'unknown' ? undefined : prep?.baseSha,
        predecessors: (prepStall !== 'unknown' || checkPinned) ? revision.predecessors?.map(p =>
          ({ number: p.number, headSha: p.headSha })) : undefined,
        mergeGroupSha: checkPinned ? revision.mergeGroupSha : undefined } : null };
  }) : null;
  const evidence = new Map(observations?.map(row => [row.entry.number, row]));
  const report = mergeAge({ prs: input.prs, queue: observations?.map(row => row.entry) ?? queue, repo: input.repo }, now);
  const actions = {
    base_movement: 'Refresh preparation against the current target base.',
    stack_wait: 'Wait for the pinned predecessors before refreshing preparation.',
    content_conflict: 'Resolve the content conflict observed in local preparation.',
  };
  const entries = report.entries.map(row => {
    const observation = evidence.get(row.number);
    if (!observation) return row;
    const { stall, stallEvidence } = observation;
    const causes = row.causes.filter(cause => cause.code !== 'stale');
    if (stall !== 'unknown' && stall !== 'check_failure') causes.unshift({ code: stall, since: null, action: actions[stall] });
    return { ...row, causes, stall, stallEvidence,
      missingData: stall === 'unknown' ? [...row.missingData, 'revision-pinned stall reason'] : row.missingData };
  });
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
  return { ...report, entries,
    oldestActionable: entries.find(row => row.ageSeconds !== null && !row.missingData.includes('unique_queue_entry') && row.causes.length) ?? null,
    schema: 'fleet.merge-queue-age.v1' as const,
    retryable_conflicts: retryable.sort((a, b) => (b.waiting_s ?? -1) - (a.waiting_s ?? -1) || a.number - b.number),
    blocked_conflicts: blocked.sort((a, b) => a.number - b.number) };
}
