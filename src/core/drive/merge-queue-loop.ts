/**
 * RQ-MERGEQ-BATCH-1: one merge-queue throughput cycle over the seven approved
 * repos. Three moves per fleet-authored PR, decided by `classifyMergeQueuePr`:
 *
 *  - enqueue: required checks green, mergeable, not yet queued, and the base
 *    branch has a GitHub merge queue. The host calls `enqueuePullRequest`
 *    with `expectedHeadOid`, so a head that moved since the read is refused
 *    by GitHub instead of queueing an unchecked revision. The merge queue
 *    re-runs every required check on the merge group; nothing here merges.
 *  - rebase: BEHIND in a repo without a merge queue, or BEHIND with no checks
 *    at all on the head in a queue repo (the queue itself tests against the
 *    latest base, so a pending or green PR there is left alone). The host calls
 *    `updatePullRequestBranch` with the MERGE method and `expectedHeadOid`:
 *    a base merge commit on top of the head, never a rewrite or force-push.
 *  - conflict: CONFLICTING/DIRTY needs an agent. One fix-forward line per
 *    head goes to the RQ queue under the same id refix-loop uses
 *    (`drainKey`), so the two producers can never double-append.
 *
 * What this cycle never does: merge, use --admin, skip or re-run checks,
 * enable auto-merge outside a merge queue, touch held or non-fleet PRs, or
 * auto-enqueue a PR whose files touch a Security-pinned path (or whose file
 * list is truncated, so the pin is unproven). Red checks belong to
 * refix-loop and are only reported.
 *
 * Failure policy: a failed repo read is logged and that repo is skipped (the
 * other repos still drain); a failed mutation consumes its retry budget and
 * the cycle continues. Budgets are written ahead of each call: one attempt per
 * (action, PR) per 15 minutes, at most 3 per rolling 24h, at most 20 of each
 * action per cycle. All I/O is injected so the cycle is unit-testable; the
 * host adapter is scripts/merge-queue-loop.mjs.
 */

import {
  FLEET_AUTHOR,
  REFIX_CYCLE_CAP,
  REFIX_PR_WINDOW_CAP,
  REFIX_REPOS,
  REFIX_RETRY_MS,
  REFIX_WINDOW_MS,
  drainKey,
  drainRow,
  securityPinnedPath,
} from './refix-loop.js';

export const MERGEQ_REPOS = REFIX_REPOS;

/** statusCheckRollup.state; NONE when the head reports no checks at all. */
export type MergeQueueChecks = 'SUCCESS' | 'PENDING' | 'EXPECTED' | 'FAILURE' | 'ERROR' | 'NONE';

export interface MergeQueuePr {
  /** GraphQL node id; the mutations address the PR by it. */
  id: string;
  number: number;
  headSha: string;
  baseRef: string;
  isDraft: boolean;
  author: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeState: string;
  checks: MergeQueueChecks;
  reviewDecision: string | null;
  inMergeQueue: boolean;
  autoMerge: boolean;
  files: string[];
  filesTruncated: boolean;
}

export interface MergeQueueRepoSnapshot {
  repo: string;
  defaultBranch: string;
  /** True only when the default branch has a GitHub merge queue. */
  mergeQueue: boolean;
  prs: MergeQueuePr[];
}

export type MergeQueueAction =
  | 'enqueue' | 'rebase' | 'conflict'
  | 'queued' | 'wait' | 'red' | 'blocked' | 'pinned' | 'no-queue' | 'skip';

export interface MergeQueueState {
  v: 1;
  /** `<action>:<short>#<n>:<epochMs>` -> attempt; reserved before each call. */
  attempts: Record<string, { pr: string; action: 'enqueue' | 'rebase' | 'resolve'; at: number }>;
  /** Drain ids this loop appended (refix shares the id space via the queue). */
  drained: Record<string, number>;
}

export interface MergeQueueIo {
  readSnapshot(repo: string): MergeQueueRepoSnapshot;
  /** enqueuePullRequest(pullRequestId, expectedHeadOid). */
  enqueue(repo: string, pr: MergeQueuePr): void;
  /** updatePullRequestBranch(pullRequestId, expectedHeadOid, updateMethod: MERGE). */
  updateBranch(repo: string, pr: MergeQueuePr): void;
  /**
   * Optional mechanical conflict resolution (core/fleet/conflict-resolve.ts):
   * merge the base into the PR head in a throwaway worktree and push the merge
   * commit (never a force-push). 'resolved' means a new head was pushed and the
   * PR needs no agent; 'real' means a conflict a model must read. A throw is
   * treated as 'real'. Absent: every conflict goes straight to the lane.
   */
  resolveConflict?(repo: string, pr: MergeQueuePr): 'resolved' | 'real';
  readQueueIds(): Set<string>;
  appendQueueLine(line: string): void;
  /** Canonical hold list as "<short>#<n>"; must throw if unreadable. */
  readHoldList(): Set<string>;
  loadState(): unknown;
  saveState(state: MergeQueueState): void;
  log(line: string): void;
  now(): number;
}

export interface MergeQueueOptions {
  repos?: readonly string[];
  cycleCap?: number;
  prWindowCap?: number;
  retryMs?: number;
  windowMs?: number;
  fleetAuthors?: readonly string[];
  /** Plan only: classify and report, no mutation and no queue append. */
  dryRun?: boolean;
}

export interface MergeQueueRepoResult {
  repo: string;
  ok: boolean;
  mergeQueue: boolean;
  totals: Partial<Record<MergeQueueAction, number>>;
  enqueued: number[];
  rebased: number[];
  resolved: number[];
  drained: number[];
  failed: number[];
}

export interface MergeQueueSummary {
  v: 1;
  dryRun: boolean;
  enqueued: number;
  rebased: number;
  /** Conflicts resolved mechanically, without a lane. */
  resolved: number;
  drained: number;
  failed: number;
  capped: boolean;
  repoErrors: number;
  repos: MergeQueueRepoResult[];
}

const SHA = /^[0-9a-f]{40}$/i;
const shortName = (repo: string): string => repo.split('/').pop() ?? repo;
/** GraphQL reports a bot as `name`, REST as `name[bot]` (see prs/merge-identity.ts). */
const bareLogin = (login: string): string => login.replace(/\[bot\]$/i, '').toLowerCase();
/** Merge states GitHub reports for a mergeable head the queue may accept. */
const QUEUEABLE = new Set(['CLEAN', 'BEHIND', 'HAS_HOOKS']);

/**
 * Pure decision for one PR. `fleet` and `held` are resolved by the caller so
 * the classifier only reads GitHub-reported facts.
 */
export function classifyMergeQueuePr(
  pr: MergeQueuePr,
  repo: { defaultBranch: string; mergeQueue: boolean },
  scope: { fleet: boolean; held: boolean },
): MergeQueueAction {
  if (!scope.fleet || scope.held || pr.isDraft || pr.baseRef !== repo.defaultBranch) return 'skip';
  if (!SHA.test(pr.headSha) || !pr.id) return 'skip';
  if (pr.inMergeQueue) return 'queued';
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return 'conflict';
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return 'red';
  if (pr.mergeable === 'UNKNOWN' || pr.mergeState === 'UNKNOWN') return 'wait';
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.reviewDecision === 'REVIEW_REQUIRED') return 'blocked';
  const green = pr.checks === 'SUCCESS' && QUEUEABLE.has(pr.mergeState);
  // The queue tests each entry against the latest base itself, so a green
  // BEHIND PR is enqueued as is; updating it first would only restart CI.
  if (green && repo.mergeQueue) {
    // Auto-merge can remain armed without queue membership. Only inMergeQueue
    // above proves admission; retry through the same head-pinned, bounded path.
    return pr.filesTruncated || pr.files.some(securityPinnedPath) ? 'pinned' : 'enqueue';
  }
  if (pr.mergeState === 'BEHIND') {
    // A queue repo never needs an up-to-date branch, and updating a head whose
    // checks are still running only restarts them. Update there only when the
    // head reports no checks at all, so the base merge triggers a fresh run.
    return !repo.mergeQueue || pr.checks === 'NONE' ? 'rebase' : 'wait';
  }
  if (green) return 'no-queue';
  if (pr.mergeState === 'BLOCKED') return 'blocked';
  return 'wait';
}

export function normalizeMergeQueueState(value: unknown): MergeQueueState {
  const state: MergeQueueState = { v: 1, attempts: {}, drained: {} };
  const row = (value ?? {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries((row['attempts'] ?? {}) as Record<string, unknown>)) {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (typeof e['pr'] === 'string' && Number.isSafeInteger(e['at'])
      && (e['action'] === 'enqueue' || e['action'] === 'rebase' || e['action'] === 'resolve')) {
      state.attempts[key] = { pr: e['pr'], action: e['action'], at: e['at'] as number };
    }
  }
  for (const [key, at] of Object.entries((row['drained'] ?? {}) as Record<string, unknown>)) {
    if (Number.isSafeInteger(at)) state.drained[key] = at as number;
  }
  return state;
}

/** One cycle. Never throws for a single repo or PR failure; the hold list is fail-closed. */
export function runMergeQueueCycle(io: MergeQueueIo, options: MergeQueueOptions = {}): MergeQueueSummary {
  const repos = options.repos ?? MERGEQ_REPOS;
  const cycleCap = options.cycleCap ?? REFIX_CYCLE_CAP;
  const prWindowCap = options.prWindowCap ?? REFIX_PR_WINDOW_CAP;
  const retryMs = options.retryMs ?? REFIX_RETRY_MS;
  const windowMs = options.windowMs ?? REFIX_WINDOW_MS;
  const authors = new Set((options.fleetAuthors ?? [FLEET_AUTHOR]).map(bareLogin));
  const dryRun = options.dryRun === true;
  const now = io.now();
  let hold: Set<string>;
  try {
    hold = io.readHoldList();
  } catch (error) {
    io.log('MERGEQ_HOLD_UNAVAILABLE');
    throw error;
  }
  let queueIds: Set<string>;
  try {
    queueIds = io.readQueueIds();
  } catch (error) {
    io.log('MERGEQ_QUEUE_INVALID');
    throw error;
  }
  const state = normalizeMergeQueueState(io.loadState());
  for (const [key, entry] of Object.entries(state.attempts)) {
    if (now - entry.at >= windowMs) delete state.attempts[key];
  }
  for (const [key, at] of Object.entries(state.drained)) {
    if (now - at >= windowMs) delete state.drained[key];
  }
  const summary: MergeQueueSummary = {
    v: 1, dryRun, enqueued: 0, rebased: 0, resolved: 0, drained: 0, failed: 0, capped: false, repoErrors: 0, repos: [],
  };
  const spent = { enqueue: 0, rebase: 0, resolve: 0, conflict: 0 };
  const budgetAllows = (action: 'enqueue' | 'rebase' | 'resolve', tag: string): boolean => {
    const prior = Object.values(state.attempts).filter((e) => e.pr === tag && e.action === action);
    return prior.length < prWindowCap && !prior.some((e) => now - e.at < retryMs);
  };

  try {
    for (const repo of repos) {
      const result: MergeQueueRepoResult = {
        repo, ok: false, mergeQueue: false, totals: {}, enqueued: [], rebased: [], resolved: [], drained: [], failed: [],
      };
      summary.repos.push(result);
      let snapshot: MergeQueueRepoSnapshot;
      try {
        snapshot = io.readSnapshot(repo);
      } catch {
        summary.repoErrors++;
        io.log(`MERGEQ_GH_ERROR read ${repo}`);
        continue;
      }
      result.ok = true;
      result.mergeQueue = snapshot.mergeQueue;
      const seen = new Set<number>();
      const planned = snapshot.prs.slice().sort((a, b) => a.number - b.number)
        .filter((pr) => {
          if (seen.has(pr.number)) return false;
          seen.add(pr.number);
          return true;
        }).map((pr) => ({ pr, action: classifyMergeQueuePr(pr, snapshot, {
          fleet: authors.has(bareLogin(pr.author)), held: hold.has(`${shortName(repo)}#${pr.number}`),
        }) }));
      // Admit ready heads before slow branch updates or conflict resolution.
      // Stable sorting preserves PR-number order within each group and its caps.
      planned.sort((a, b) => Number(b.action === 'enqueue') - Number(a.action === 'enqueue'));
      for (const { pr, action } of planned) {
        const tag = `${shortName(repo)}#${pr.number}`;
        result.totals[action] = (result.totals[action] ?? 0) + 1;
        if (dryRun || (action !== 'enqueue' && action !== 'rebase' && action !== 'conflict')) continue;

        if (action === 'conflict') {
          const key = drainKey(repo, pr.number, pr.headSha);
          if (queueIds.has(key) || key in state.drained) continue;
          // Mechanical first: lockfile, generated and changelog conflicts never need a model.
          if (io.resolveConflict && budgetAllows('resolve', tag) && spent.resolve < cycleCap) {
            spent.resolve++;
            state.attempts[`resolve:${tag}:${now}`] = { pr: tag, action: 'resolve', at: now };
            io.saveState(state);
            let outcome: 'resolved' | 'real' = 'real';
            try { outcome = io.resolveConflict(repo, pr); } catch { io.log(`MERGEQ_GH_ERROR resolve ${repo}#${pr.number}`); }
            if (outcome === 'resolved') {
              result.resolved.push(pr.number);
              summary.resolved++;
              io.log(`MERGEQ_RESOLVE ${repo}#${pr.number} head=${pr.headSha.slice(0, 7)}`);
              continue;
            }
          }
          if (spent.conflict >= cycleCap) { summary.capped = true; continue; }
          spent.conflict++;
          io.appendQueueLine(drainRow(repo, {
            number: pr.number, headSha: pr.headSha, mergeState: pr.mergeState,
            inMergeQueue: pr.inMergeQueue, author: pr.author, files: pr.files, filesTruncated: pr.filesTruncated,
          }, key, 'merge conflict (DIRTY)', pr.filesTruncated || pr.files.some(securityPinnedPath)));
          queueIds.add(key);
          state.drained[key] = now;
          result.drained.push(pr.number);
          summary.drained++;
          io.log(`MERGEQ_DRAIN ${key}`);
          continue;
        }

        if (!budgetAllows(action, tag)) continue;
        if (spent[action] >= cycleCap) { summary.capped = true; continue; }
        spent[action]++;
        // Write ahead: an ambiguous provider failure must not become a tight retry loop.
        state.attempts[`${action}:${tag}:${now}`] = { pr: tag, action, at: now };
        io.saveState(state);
        try {
          if (action === 'enqueue') io.enqueue(repo, pr);
          else io.updateBranch(repo, pr);
        } catch {
          // Provider text may carry credentials; only the constant line is logged.
          result.failed.push(pr.number);
          summary.failed++;
          io.log(`MERGEQ_GH_ERROR ${action} ${repo}#${pr.number}`);
          continue;
        }
        if (action === 'enqueue') { result.enqueued.push(pr.number); summary.enqueued++; }
        else { result.rebased.push(pr.number); summary.rebased++; }
        io.log(`MERGEQ_${action.toUpperCase()} ${repo}#${pr.number} head=${pr.headSha.slice(0, 7)}`);
      }
    }
    io.log(`MERGEQ_CYCLE enqueued=${summary.enqueued} rebased=${summary.rebased} resolved=${summary.resolved} drained=${summary.drained} ` +
      `failed=${summary.failed} repoErrors=${summary.repoErrors} capped=${summary.capped ? 1 : 0} dryRun=${dryRun ? 1 : 0}`);
    return summary;
  } finally {
    if (!dryRun) io.saveState(state);
  }
}
