/**
 * core/fleet/merge-recut.ts: automatic recut for stale or conflicting fleet
 * PRs (RQ-MERGELATENCYN21Q8).
 *
 * The merge-queue loop (core/drive/merge-queue-loop.ts) enqueues green PRs and
 * updates BEHIND ones through `updatePullRequestBranch`; until now every
 * conflict was drained to an agent lane, even though a DIRTY bridge PR usually
 * conflicts only on files no model needs to read (lockfiles, generated docs,
 * the changelog — see core/fleet/conflict-resolve.ts). That lane job cost
 * hours of merge latency per PR.
 *
 * This module recuts such a PR automatically: fetch the pinned PR head and
 * the current default branch into a disposable object store, merge the
 * default branch into the head in a throwaway worktree, resolve the
 * mechanical conflicts with the conflict-resolve policy, and push the single
 * merge commit back to the PR branch. The loop then re-observes the fresh
 * head and re-enrolls it only once every required check is green again: the
 * merge queue still runs each required check on the merge group, so nothing
 * here merges, skips or re-runs a check.
 *
 * Safety (the rules the loop already enforces, restated at this boundary):
 *  - Only same-repo `codex-bridge/*` heads of the seven approved repos, based
 *    on the default branch, not draft, not queued, with a complete file list
 *    that touches no Security-pinned path (securityPinnedPath). Fork heads and
 *    pinned PRs stay with the lane, exactly as before.
 *  - The push is a lease-protected fast-forward of the observed head:
 *    `ls-remote` must still report the branch at the pinned SHA, and the push
 *    carries `--force-with-lease=refs/heads/<ref>:<headSha>`. A moved or
 *    deleted branch (a concurrent writer, or the PR merging mid-flight) is
 *    refused; the merge commit only ever adds to the head, nothing is forced,
 *    and no branch is ever created by this module.
 *  - Repository hooks and commit signing are disabled for the disposable
 *    worktree, generators are bounded by the injected runner, and every
 *    outcome reason is a constant string: git/provider output may carry
 *    credentials and is never returned or logged.
 *  - Any conflict that is not provably mechanical stays with the agent lane.
 */
import { join } from 'node:path';
import type { MergeQueuePr } from '../drive/merge-queue-loop.js';
import { REFIX_REPOS, securityPinnedPath } from '../drive/refix-loop.js';
import { planMechanicalResolution, unionResolve } from './conflict-resolve.js';

/** Fleet-owned PR head branches; mirrors the update-behind.mjs authority line. */
export const MERGE_RECUT_BRANCH_RE = /^codex-bridge\/[A-Za-z0-9_-]{1,120}$/;
const REPO_RE = /^ashlrai\/[a-z0-9][a-z0-9._-]{0,99}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const badBranch = (branch: string): boolean =>
  !BRANCH_RE.test(branch) || branch.startsWith('-') || branch.split('/').includes('..');
const SHA_RE = /^[0-9a-f]{40}$/;
const REMOTE_RE = /^[A-Za-z0-9:/._~@+-]{1,200}$/;
const READ_LIMIT = 2 * 1024 * 1024;

export interface MergeRecutPr {
  number: number;
  headSha: string;
  headRef: string;
  /** Same-repo heads only (`owner/name`); fork heads are `null` and stay with the lane. */
  headRepo: string | null;
  baseRef: string;
  isDraft: boolean;
  inMergeQueue: boolean;
  files: readonly string[];
  filesTruncated: boolean;
}

export interface MergeRecutPlan {
  repo: string;
  number: number;
  /** Observed head; every later step re-proves the branch still sits here. */
  headSha: string;
  headRef: string;
  baseRef: string;
}

export type MergeRecutRefusal =
  | 'repo' | 'pr' | 'head' | 'branch' | 'fork' | 'base'
  | 'draft' | 'queued' | 'files' | 'pinned';

/**
 * Pure eligibility. Every refusal keeps the PR on its previous path (the
 * agent lane), so a refusal can never widen authority here.
 */
export function planMergeRecut(input: {
  repo: string;
  defaultBranch: string;
  pr: MergeRecutPr;
}): { ok: true; plan: MergeRecutPlan } | { ok: false; reason: MergeRecutRefusal } {
  const { repo, defaultBranch, pr } = input;
  if (!REPO_RE.test(repo) || !(REFIX_REPOS as readonly string[]).includes(repo)) return { ok: false, reason: 'repo' };
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) return { ok: false, reason: 'pr' };
  if (!SHA_RE.test(pr.headSha)) return { ok: false, reason: 'head' };
  if (!MERGE_RECUT_BRANCH_RE.test(pr.headRef)) return { ok: false, reason: 'branch' };
  if (pr.headRepo !== repo) return { ok: false, reason: 'fork' };
  if (!BRANCH_RE.test(defaultBranch) || defaultBranch.startsWith('-')
    || pr.baseRef !== defaultBranch) return { ok: false, reason: 'base' };
  if (pr.isDraft) return { ok: false, reason: 'draft' };
  if (pr.inMergeQueue) return { ok: false, reason: 'queued' };
  if (pr.filesTruncated) return { ok: false, reason: 'files' };
  if (pr.files.some(securityPinnedPath)) return { ok: false, reason: 'pinned' };
  return { ok: true, plan: { repo, number: pr.number, headSha: pr.headSha, headRef: pr.headRef, baseRef: defaultBranch } };
}

export interface MergeRecutRunner {
  /**
   * Run git. Never echoes provider text upward beyond stdout the caller asked
   * for; non-zero exits throw unless `allowFail` returns `{code}` instead.
   */
  git(args: readonly string[], opts?: { cwd?: string; allowFail?: boolean }): { code: number; stdout: string };
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  mkdir(path: string): void;
  mkdtemp(prefix: string): string;
  rmrf(path: string): void;
  /** Bounded generator run (lockfile/doc regeneration); true on exit 0. */
  run(cwd: string, argv: readonly string[]): boolean;
}

export type MergeRecutOutcome =
  | { status: 'resolved'; commit: string; pushed: boolean; resolved: readonly string[] }
  | { status: 'real'; reason: 'not-eligible' | 'content-conflict' | 'regenerate-failed' | 'merge-failed' }
  | { status: 'transient'; reason: 'head-moved' | 'branch-moved' | 'branch-gone' | 'push-refused' | 'git-failed' };

/** Hooks, signing and fsmonitor off for every git call in the disposable store. */
const GUARD = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
  '-c', 'core.fsmonitor=false', '-c', 'user.name=ashlr merge queue', '-c', 'user.email=merge-queue@ashlr.invalid'];

/**
 * Recut one planned PR against the current default branch. All work happens
 * in a disposable object store + worktree under `runner.mkdtemp`; the only
 * persistent effect is one fast-forward push of a merge commit to the PR's
 * own head branch, and only when the branch still sits at `plan.headSha`.
 */
export function executeMergeRecut(
  runner: MergeRecutRunner,
  plan: MergeRecutPlan,
  remote: string,
): MergeRecutOutcome {
  if (!REMOTE_RE.test(remote) || remote.startsWith('-')) throw new Error('invalid remote');
  const git = (args: readonly string[], opts?: { cwd?: string; allowFail?: boolean }) =>
    runner.git([...GUARD, ...args], opts);
  const root = runner.mkdtemp('phantom-merge-recut-');
  const store = join(root, 'objects.git');
  const empty = join(root, 'empty-template');
  const wt = join(root, 'worktree');
  let worktreeAdded = false;
  try {
    runner.mkdir(empty);
    git(['init', '--bare', `--template=${empty}`, store], { cwd: root });
    git(['fetch', '--no-tags', '--no-write-fetch-head', remote,
      `refs/heads/${plan.baseRef}:refs/remotes/recut/base`,
      `refs/pull/${plan.number}/head:refs/recut/head`], { cwd: store });
    if (git(['rev-parse', 'refs/recut/head'], { cwd: store }).stdout.trim() !== plan.headSha) {
      return { status: 'transient', reason: 'head-moved' };
    }
    const base = git(['rev-parse', 'refs/remotes/recut/base'], { cwd: store }).stdout.trim();
    git(['worktree', 'add', '--detach', wt, plan.headSha], { cwd: store });
    worktreeAdded = true;

    const merged = git(['merge', '--no-ff', '--no-edit', '--no-verify', base], { cwd: wt, allowFail: true });
    let commit: string;
    let resolvedPaths: readonly string[] = [];
    if (merged.code === 0) {
      commit = git(['rev-parse', 'HEAD'], { cwd: wt }).stdout.trim();
    } else {
      const listed = git(['diff', '--name-only', '--diff-filter=U'], { cwd: wt }).stdout
        .split('\n').map(path => path.trim()).filter(Boolean);
      const resolution = planMechanicalResolution(listed);
      if (resolution.verdict === 'none') return { status: 'transient', reason: 'git-failed' };
      if (resolution.verdict === 'real') return { status: 'real', reason: 'content-conflict' };
      const generators = new Map<string, readonly string[]>();
      for (const entry of resolution.mechanical) {
        if (entry.strategy === 'union') {
          const union = unionResolve(runner.readFile(join(wt, entry.path)));
          if (!union.ok) return { status: 'real', reason: 'content-conflict' };
          runner.writeFile(join(wt, entry.path), union.text);
        } else {
          // Start from the base copy so the generator sees no markers.
          git(['checkout', '--theirs', '--', entry.path], { cwd: wt });
          generators.set(entry.generator!.join('\0'), entry.generator!);
        }
      }
      for (const argv of generators.values()) {
        if (!runner.run(wt, argv)) return { status: 'real', reason: 'regenerate-failed' };
      }
      git(['add', '--', ...resolution.mechanical.map(entry => entry.path)], { cwd: wt });
      if (git(['diff', '--name-only', '--diff-filter=U'], { cwd: wt }).stdout.trim()) {
        return { status: 'transient', reason: 'git-failed' };
      }
      git(['commit', '--no-edit', '--no-verify'], { cwd: wt });
      commit = git(['rev-parse', 'HEAD'], { cwd: wt }).stdout.trim();
      resolvedPaths = resolution.mechanical.map(entry => entry.path);
    }
    if (commit === plan.headSha) {
      // The head already contains the default branch: GitHub's conflict report
      // was stale. Nothing to push; the loop's re-read takes it from here.
      return { status: 'resolved', commit, pushed: false, resolved: resolvedPaths };
    }
    // Pin the branch before pushing: a deleted branch (PR merged mid-flight,
    // branch auto-deleted) or a moved one is never rewritten or recreated.
    const tip = git(['ls-remote', '--refs', remote, `refs/heads/${plan.headRef}`], { cwd: store })
      .stdout.trim().split(/\s+/)[0];
    if (!tip) return { status: 'transient', reason: 'branch-gone' };
    if (tip !== plan.headSha) return { status: 'transient', reason: 'branch-moved' };
    const pushed = git(['push', '--no-verify',
      `--force-with-lease=refs/heads/${plan.headRef}:${plan.headSha}`,
      remote, `${commit}:refs/heads/${plan.headRef}`], { cwd: wt, allowFail: true });
    if (pushed.code !== 0) return { status: 'transient', reason: 'push-refused' };
    return { status: 'resolved', commit, pushed: true, resolved: resolvedPaths };
  } catch {
    return { status: 'transient', reason: 'git-failed' };
  } finally {
    if (worktreeAdded) git(['worktree', 'remove', '--force', wt], { cwd: store, allowFail: true });
    runner.rmrf(root);
  }
}

/** What core/drive/merge-queue-loop.ts expects from its conflict resolver. */
export type MergeQueueResolveOutcome = 'resolved' | 'real' | 'transient';

/**
 * Adapter for `MergeQueueIo.resolveConflict` (which is synchronous): plan,
 * execute and flatten to the loop's vocabulary. Never throws; a refusal or a
 * real conflict keeps the PR on the agent lane, a transient outcome retries
 * under the loop's existing per-PR budget.
 */
export function makeMergeRecutResolver(
  runner: MergeRecutRunner,
  remoteOf: (repo: string) => string = repo => `https://github.com/${repo}.git`,
): (repo: string, pr: MergeQueuePr) => MergeQueueResolveOutcome {
  // The loop classifies `conflict` only for PRs based on the repo's default
  // branch, so `pr.baseRef` restates it here; planMergeRecut re-proves it.
  return (repo, pr) => {
    const planned = planMergeRecut({ repo, defaultBranch: pr.baseRef, pr });
    if (!planned.ok) return 'real';
    try {
      const outcome = executeMergeRecut(runner, planned.plan, remoteOf(repo));
      return outcome.status;
    } catch {
      return 'transient';
    }
  };
}
