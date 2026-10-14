/**
 * Autonomous promotion for self-improvement PRs, gated by evidence instead of a
 * person: the PR's own checks are all green on its exact head, and its declared
 * metric improved between the exact merge base and that head. Promotion only
 * queues GitHub auto-merge with `--match-head-commit`, so branch protection and
 * required checks still decide the merge. It never uses `--admin`, never
 * pushes, tags or deploys directly; deploys happen only where the repository's
 * own merge-triggered CI already performs them.
 */
import { execFileSync } from 'node:child_process';
import type { ProposalOutcome } from './outcomes.js';

export type PromoteExec = (cmd: string, args: string[], cwd: string) => string;
const realExec: PromoteExec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Branch prefixes owned by Phantom's own improvement agents. Other owners' PRs are never promoted. */
export const PROMOTABLE_BRANCH_PREFIXES = ['improve/', 'ashlr-cloud/'] as const;

export interface PrCheck { name: string; state: 'success' | 'pending' | 'failure' }
export interface PrSnapshot {
  number: number;
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  checks: PrCheck[];
}
export interface PromotionDecision { admit: boolean; reasons: string[] }

export function evaluatePromotion(input: {
  outcome: ProposalOutcome | undefined;
  pr: PrSnapshot;
  defaultBranch: string;
  mergeBase: string;
  ledgerIntact: boolean;
}): PromotionDecision {
  const { outcome, pr } = input;
  const reasons: string[] = [];
  if (!input.ledgerIntact) reasons.push('outcome ledger is not intact');
  if (!outcome) reasons.push('no registered proposal with a declared metric');
  if (pr.state !== 'OPEN') reasons.push(`PR is ${pr.state.toLowerCase()}, not open`);
  if (pr.isCrossRepository) reasons.push('PR head is in another repository');
  if (!PROMOTABLE_BRANCH_PREFIXES.some((p) => pr.headRefName.startsWith(p))) reasons.push(`branch ${pr.headRefName} is not owned by the improvement loop`);
  if (pr.baseRefName !== input.defaultBranch) reasons.push(`PR targets ${pr.baseRefName}, not the default branch ${input.defaultBranch}`);
  if (!pr.checks.length) reasons.push('no checks reported on the head commit');
  const pending = pr.checks.filter((c) => c.state === 'pending').map((c) => c.name);
  const failed = pr.checks.filter((c) => c.state === 'failure').map((c) => c.name);
  if (pending.length) reasons.push(`checks still pending: ${pending.slice(0, 5).join(', ')}`);
  if (failed.length) reasons.push(`checks not green: ${failed.slice(0, 5).join(', ')}`);
  if (outcome) {
    if (outcome.pr && outcome.pr.number !== pr.number) reasons.push(`proposal is linked to PR #${outcome.pr.number}, not #${pr.number}`);
    if (outcome.status !== 'improved') reasons.push(`metric ${outcome.metric.name} is ${outcome.status}${outcome.reasons.length ? ` (${outcome.reasons.join('; ')})` : ''}`);
    if (outcome.head && outcome.head.sha !== pr.headRefOid) reasons.push('metric was measured on a different head commit; re-measure');
    if (outcome.base && outcome.base.sha !== input.mergeBase) reasons.push('base branch moved since the baseline was measured; re-measure');
  }
  return { admit: reasons.length === 0, reasons };
}

type RollupItem = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string | null; state?: string };
export function normalizeChecks(rollup: unknown): PrCheck[] {
  if (!Array.isArray(rollup)) return [];
  return (rollup as RollupItem[]).map((c) => {
    if (c.__typename === 'StatusContext' || (c.context && c.state)) {
      const s = String(c.state).toUpperCase();
      return { name: String(c.context ?? 'status'), state: s === 'SUCCESS' ? 'success' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'failure' };
    }
    if (String(c.status).toUpperCase() !== 'COMPLETED') return { name: String(c.name ?? 'check'), state: 'pending' };
    const k = String(c.conclusion).toUpperCase();
    return { name: String(c.name ?? 'check'), state: k === 'SUCCESS' || k === 'NEUTRAL' || k === 'SKIPPED' ? 'success' : 'failure' };
  });
}

export function readPr(repository: string, number: number, repoDir: string, exec: PromoteExec = realExec): PrSnapshot {
  const raw = JSON.parse(exec('gh', ['pr', 'view', String(number), '--repo', repository, '--json',
    'number,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,statusCheckRollup'], repoDir)) as Record<string, unknown>;
  return { number: Number(raw.number), state: String(raw.state), isDraft: raw.isDraft === true, isCrossRepository: raw.isCrossRepository !== false,
    headRefName: String(raw.headRefName ?? ''), headRefOid: String(raw.headRefOid ?? ''), baseRefName: String(raw.baseRefName ?? ''),
    checks: normalizeChecks(raw.statusCheckRollup) };
}

export function defaultBranchOf(repoDir: string, exec: PromoteExec = realExec): string {
  const head = exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir).trim();
  if (!head.startsWith('origin/') || head.length <= 'origin/'.length) throw new Error('An exact origin default branch is required.');
  return head.slice('origin/'.length);
}

/** Exact merge base of the PR head with the current default branch, after fetching both. */
export function prMergeBase(repoDir: string, pr: PrSnapshot, defaultBranch: string, exec: PromoteExec = realExec): string {
  exec('git', ['fetch', 'origin', defaultBranch, `refs/pull/${pr.number}/head`], repoDir);
  const base = exec('git', ['merge-base', `origin/${defaultBranch}`, pr.headRefOid], repoDir).trim();
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('Could not resolve an exact merge base.');
  return base;
}

/** Queue the merge on GitHub. Required checks and branch protection still apply there. */
export function queueMerge(repository: string, pr: PrSnapshot, repoDir: string, exec: PromoteExec = realExec): void {
  if (pr.isDraft) exec('gh', ['pr', 'ready', String(pr.number), '--repo', repository], repoDir);
  exec('gh', ['pr', 'merge', String(pr.number), '--repo', repository, '--squash', '--auto', '--match-head-commit', pr.headRefOid], repoDir);
}
