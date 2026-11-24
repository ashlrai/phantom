/**
 * RQ-MERGEQ-BATCH-1: one merge-queue throughput cycle over the seven approved
 * repos. Three moves per fleet-authored PR, decided by `classifyMergeQueuePr`:
 *
 *  - enqueue: required checks green, mergeable, not yet queued, and the base
 *    branch has a GitHub merge queue. The host calls `gh pr merge --auto`
 *    with `--match-head-commit`, so a head that moved since the read is refused
 *    by GitHub instead of queueing an unchecked revision. The merge queue
 *    re-runs every required check on the merge group; nothing here merges.
 *  - rebase: BEHIND in a repo without a merge queue, or BEHIND with no checks
 *    at all on the head in a queue repo (the queue itself tests against the
 *    latest base, so a pending or green PR there is left alone). The host calls
 *    `updatePullRequestBranch` with the MERGE method and `expectedHeadOid`:
 *    a base merge commit on top of the head, never a rewrite or force-push.
 *  - conflict: CONFLICTING/DIRTY is first recut automatically when a resolver
 *    is wired (core/fleet/merge-recut.ts): the current default branch is
 *    merged into the PR head in a throwaway worktree, mechanical conflicts
 *    (lockfile, generated, changelog) are resolved, and the single merge
 *    commit is pushed back as a lease-protected fast-forward — never a
 *    rewrite. A recut head restarts every required check and re-enters only
 *    through the same gated auto-merge path. What the recut cannot prove
 *    mechanical keeps the agent lane: one fix-forward line per head goes to
 *    the RQ queue under the same id refix-loop uses (`drainKey`), so the two
 *    producers can never double-append. Recovery re-reads open PRs before
 *    acting and after resolution; a mid-flight observation race ('transient')
 *    spends no lane job and retries under the same budget.
 *
 * What this cycle never does: merge, use --admin, skip required checks,
 * enable auto-merge outside a merge queue, touch held or non-fleet PRs, or
 * auto-enqueue a PR whose files touch a Security-pinned path (or whose file
 * list is truncated, so the pin is unproven). Red checks belong to
 * refix-loop and are only reported.
 *
 * Queued entries observed for an hour are refreshed, then safely dequeued and
 * re-enrolled if all head gates still pass. Recovery shares enqueue budgets.
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
  /** PR head branch name; the automatic recut pushes its merge commit here. */
  headRef: string;
  /** Head repository (`owner/name`); `null` for fork-hosted heads. */
  headRepo: string | null;
  baseRef: string;
  isDraft: boolean;
  author: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeState: string;
  checks: MergeQueueChecks;
  reviewDecision: string | null;
  inMergeQueue: boolean;
  autoMerge: boolean;
  activeOwner?: boolean;
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
  | 'queued' | 'wait' | 'red' | 'blocked' | 'pinned' | 'no-queue' | 'skip' | 'owned';

const BLOCKERS = ['conflict', 'stale', 'checks', 'review'] as const;
export type MergeQueueBlocker = typeof BLOCKERS[number];

export interface MergeQueueLatency {
  headSha: string;
  state: MergeQueueAction;
  since: number;
  observedAt: number;
  stateMs: Partial<Record<MergeQueueAction, number>>;
  /** Independent of the action: queued/owned PRs may still have blockers. */
  blockers?: MergeQueueBlocker[];
  /** Sampled, overlapping durations; do not sum them as total queue time. */
  blockerMs?: Partial<Record<MergeQueueBlocker, number>>;
}

export interface MergeQueueState {
  v: 1;
  /** `<action>:<short>#<n>:<epochMs>` -> attempt; reserved before each call. */
  attempts: Record<string, { pr: string; action: 'enqueue' | 'rebase' | 'resolve'; at: number }>;
  /** Drain ids this loop appended (refix shares the id space via the queue). */
  drained: Record<string, number>;
  latency?: Record<string, MergeQueueLatency>;
}

export interface MergeQueueIo {
  readSnapshot(repo: string): MergeQueueRepoSnapshot;
  /** Head-pinned auto-merge enrollment; GitHub still enforces the merge queue. */
  enqueue(repo: string, pr: MergeQueuePr): void;
  /** Optional sanctioned dequeue before head-pinned enrollment of a stalled entry. */
  dequeue?(repo: string, pr: MergeQueuePr): void;
  /** updatePullRequestBranch(pullRequestId, expectedHeadOid, updateMethod: MERGE). */
  updateBranch(repo: string, pr: MergeQueuePr): void;
  /**
   * Optional automatic recut (core/fleet/merge-recut.ts): merge the current
   * default branch into the PR head in a throwaway worktree, resolve the
   * mechanical conflicts (conflict-resolve.ts policy) and push the single
   * merge commit back to the PR branch — a lease-protected fast-forward,
   * never a force-push. 'resolved' means the head was recut and the PR needs
   * no agent; 'real' means a conflict a model must read; 'transient' means an
   * observation raced (moved head or branch, provider failure) and the PR
   * should retry under its existing budget instead of spending a lane. A
   * throw is still treated as 'real'. Absent: every conflict goes straight to
   * the lane.
   */
  resolveConflict?(repo: string, pr: MergeQueuePr): 'resolved' | 'real' | 'transient';
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
  /** Continuous observed queue time before recovery; defaults to one hour. */
  stalledMs?: number;
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
  /** PRs whose continuous sampled queue residence reached the timeout. */
  stalled: number[];
  /** Successful re-enrollment requests, not completed merges. */
  recovered: number[];
  rebased: number[];
  resolved: number[];
  drained: number[];
  failed: number[];
  latency: Array<MergeQueueLatency & { number: number }>;
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
  if (pr.activeOwner) return 'owned';
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
  const actions = new Set<MergeQueueAction>(['enqueue', 'rebase', 'conflict', 'queued', 'wait', 'red', 'blocked', 'pinned', 'no-queue', 'skip', 'owned']);
  for (const [key, raw] of Object.entries((row['latency'] ?? {}) as Record<string, MergeQueueLatency>)) {
    if (raw && typeof raw.headSha === 'string' && SHA.test(raw.headSha) && actions.has(raw.state)
      && Number.isSafeInteger(raw.since) && raw.since >= 0 && Number.isSafeInteger(raw.observedAt) && raw.observedAt >= raw.since
      && raw.stateMs && typeof raw.stateMs === 'object' && !Array.isArray(raw.stateMs)
      && Object.entries(raw.stateMs).every(([s, ms]) => actions.has(s as MergeQueueAction) && Number.isSafeInteger(ms) && ms >= 0)
      && (raw.blockers === undefined || (Array.isArray(raw.blockers)
        && new Set(raw.blockers).size === raw.blockers.length && raw.blockers.every(b => BLOCKERS.includes(b))))
      && (raw.blockerMs === undefined || (raw.blockerMs && typeof raw.blockerMs === 'object' && !Array.isArray(raw.blockerMs)
        && Object.entries(raw.blockerMs).every(([b, ms]) => BLOCKERS.includes(b as MergeQueueBlocker) && Number.isSafeInteger(ms) && ms >= 0)))) {
      (state.latency ??= {})[key] = { headSha: raw.headSha, state: raw.state,
        since: raw.since, observedAt: raw.observedAt, stateMs: { ...raw.stateMs },
        blockers: [...(raw.blockers ?? [])], blockerMs: { ...raw.blockerMs } };
    }
  }
  return state;
}

/** One cycle. Never throws for a single repo or PR failure; the hold list is fail-closed. */
export function runMergeQueueCycle(io: MergeQueueIo, options: MergeQueueOptions = {}): MergeQueueSummary {
  const repos = options.repos ?? MERGEQ_REPOS;
  const cycleCap = options.cycleCap ?? REFIX_CYCLE_CAP;
  const prWindowCap = options.prWindowCap ?? REFIX_PR_WINDOW_CAP;
  const retryMs = options.retryMs ?? REFIX_RETRY_MS;
  const stalledMs = options.stalledMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(stalledMs) || stalledMs <= 0) throw new Error('invalid stalledMs');
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
        repo, ok: false, mergeQueue: false, totals: {}, enqueued: [], stalled: [], recovered: [], rebased: [], resolved: [], drained: [], failed: [], latency: [],
      };
      summary.repos.push(result);
      let snapshot: MergeQueueRepoSnapshot;
      try {
        snapshot = io.readSnapshot(repo);
      } catch {
        for (const key of Object.keys(state.latency ?? {})) if (key.startsWith(`${repo}#`)) delete state.latency![key];
        summary.repoErrors++;
        io.log(`MERGEQ_GH_ERROR read ${repo}`);
        continue;
      }
      result.ok = true;
      result.mergeQueue = snapshot.mergeQueue;
      const observedAt = io.now();
      for (const key of Object.keys(state.latency ?? {})) {
        if (key.startsWith(`${repo}#`) && !snapshot.prs.some(pr => key === `${repo}#${pr.number}`)) delete state.latency![key];
      }
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
      for (const candidate of planned) {
        let { pr, action } = candidate;
        const tag = `${shortName(repo)}#${pr.number}`;
        const key = `${repo}#${pr.number}`, previous = state.latency?.[key];
        const latency: MergeQueueLatency = previous?.headSha === pr.headSha && observedAt >= previous.observedAt
          ? { ...previous, stateMs: { ...previous.stateMs }, blockerMs: { ...previous.blockerMs } }
          : { headSha: pr.headSha, state: action, since: observedAt, observedAt, stateMs: {} };
        const elapsed = observedAt - latency.observedAt;
        latency.stateMs[latency.state] = (latency.stateMs[latency.state] ?? 0) + elapsed;
        latency.blockerMs ??= {};
        for (const blocker of latency.blockers ?? []) {
          latency.blockerMs[blocker] = (latency.blockerMs[blocker] ?? 0) + elapsed;
        }
        latency.blockers = [];
        if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') latency.blockers.push('conflict');
        if (pr.mergeState === 'BEHIND') latency.blockers.push('stale');
        if (pr.checks !== 'SUCCESS') latency.blockers.push('checks');
        if (['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision ?? '')) latency.blockers.push('review');
        for (const blocker of latency.blockers) latency.blockerMs[blocker] ??= 0;
        if (latency.state !== action) latency.since = observedAt;
        latency.state = action;
        latency.observedAt = observedAt;
        (state.latency ??= {})[key] = latency;
        result.latency.push({ number: pr.number, ...latency });
        result.totals[action] = (result.totals[action] ?? 0) + 1;
        const stalled = action === 'queued' && observedAt - latency.since >= stalledMs;
        if (stalled) result.stalled.push(pr.number);
        const recover = stalled && Boolean(io.dequeue) && classifyMergeQueuePr({ ...pr, inMergeQueue: false }, snapshot, {
          fleet: authors.has(bareLogin(pr.author)), held: hold.has(tag),
        }) === 'enqueue';
        if (dryRun) continue;
        if (recover) action = 'enqueue';
        if (action !== 'enqueue' && action !== 'rebase' && action !== 'conflict') continue;

        if (action === 'conflict') {
          const initialKey = drainKey(repo, pr.number, pr.headSha);
          if (queueIds.has(initialKey) || initialKey in state.drained) continue;
          if (!budgetAllows('resolve', tag)) continue;
          if (spent.resolve >= cycleCap) { summary.capped = true; continue; }
          // Reserve the whole recovery, including reads, before any provider call.
          spent.resolve++;
          state.attempts[`resolve:${tag}:${now}`] = { pr: tag, action: 'resolve', at: now };
          io.saveState(state);
          const reread = (): { pr: MergeQueuePr; action: MergeQueueAction } | null => {
            try {
              const fresh = io.readSnapshot(repo);
              const current = fresh.prs.find(p => p.number === pr.number && p.id === pr.id);
              const held = io.readHoldList();
              return current ? { pr: current, action: classifyMergeQueuePr(current, fresh, {
                fleet: authors.has(bareLogin(current.author)), held: held.has(tag),
              }) } : null; // Already merged/closed: no repair or requeue.
            } catch {
              result.failed.push(pr.number); summary.failed++;
              io.log(`MERGEQ_GH_ERROR recovery-read ${repo}#${pr.number}`);
              return null;
            }
          };
          const current = reread();
          if (!current) continue;
          ({ pr, action } = current);
          // Mechanical first: lockfile, generated and changelog conflicts never need a model.
          if (action === 'conflict' && io.resolveConflict) {
            let outcome: 'resolved' | 'real' | 'transient' = 'real';
            try { outcome = io.resolveConflict(repo, pr); } catch { io.log(`MERGEQ_GH_ERROR resolve ${repo}#${pr.number}`); }
            if (outcome === 'transient') {
              // The recut observed a race (moved head or branch, provider
              // failure): spend no lane job, retry under the same budget.
              result.failed.push(pr.number);
              summary.failed++;
              io.log(`MERGEQ_GH_ERROR resolve ${repo}#${pr.number}`);
              continue;
            }
            if (outcome === 'resolved') {
              result.resolved.push(pr.number);
              summary.resolved++;
              io.log(`MERGEQ_RESOLVE ${repo}#${pr.number} head=${pr.headSha.slice(0, 7)}`);
              const recovered = reread();
              if (!recovered) continue;
              ({ pr, action } = recovered);
              // GitHub may still report the old conflicting head while settling.
              if (action === 'conflict') continue;
            }
          }
          if (action === 'conflict') {
            const key = drainKey(repo, pr.number, pr.headSha);
            if (queueIds.has(key) || key in state.drained) continue;
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
        }

        if (action !== 'enqueue' && action !== 'rebase') continue;
        if (!budgetAllows(action, tag)) continue;
        if (spent[action] >= cycleCap) { summary.capped = true; continue; }
        spent[action]++;
        // Write ahead: an ambiguous provider failure must not become a tight retry loop.
        state.attempts[`${action}:${tag}:${now}`] = { pr: tag, action, at: now };
        io.saveState(state);
        try {
          if (recover) {
            // Reserve before refresh/dequeue: an ambiguous response cannot loop.
            const fresh = io.readSnapshot(repo);
            const current = fresh.prs.find(p => p.number === pr.number && p.id === pr.id && p.headSha === pr.headSha);
            const held = io.readHoldList();
            if (!current || classifyMergeQueuePr({ ...current, inMergeQueue: false }, fresh, {
              fleet: authors.has(bareLogin(current.author)), held: held.has(tag),
            }) !== 'enqueue') continue; // Merged, moved, owned or newly blocked.
            pr = current;
            if (pr.inMergeQueue) io.dequeue!(repo, pr);
          }
          if (action === 'enqueue') io.enqueue(repo, pr);
          else io.updateBranch(repo, pr);
        } catch {
          // Provider text may carry credentials; only the constant line is logged.
          result.failed.push(pr.number);
          summary.failed++;
          io.log(`MERGEQ_GH_ERROR ${action} ${repo}#${pr.number}`);
          continue;
        }
        if (recover) { result.recovered.push(pr.number); latency.since = observedAt; }
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
