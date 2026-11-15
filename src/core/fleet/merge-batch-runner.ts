/** Pure next-action compiler. No GitHub, queue writes, clock or execution authority. */
import { isTestPath, matchProtectedPath, normalizeRepoPath } from '../authority/protected-paths.js';
import { securityPinnedPath } from '../drive/queuegen.js';
import { MAX_FILES_PER_PR, MAX_PRS, MERGE_BATCH_SCHEMA, type MergeBatchPlan, type MergeBatchPr } from './merge-batch.js';
import { coveredPrNumbers, rebaseAttemptsSpent, reworkSuperseded, type RebasePlanExistingJob } from './rebase-plan.js';

export const MERGE_BATCH_RUN_SCHEMA = 'fleet.merge-batch-run.v1' as const;
export type MergeBatchRiskTier = 'low' | 'standard' | 'protected' | 'unknown';
export type MergeBatchActionKind = 'enqueue-merge' | 'rebase' | 'close-review' | 'wait';

/** Structured dispatch input; PR dependencies are merged PRs, never completed jobs. */
export interface MergeBatchRebaseJob {
  id: string;
  repo: string;
  number: number;
  headRef: string;
  headSha: string;
  pool: 'any';
  tier: 'work';
  status: 'READY' | 'WAITING';
  afterMerged: number[];
  securityPinRequired: boolean;
}

export interface MergeBatchAction {
  number: number;
  batch: string;
  headSha: string | null;
  kind: MergeBatchActionKind;
  reason: string;
  /** True only for actions eligible in this snapshot; consumers still revalidate. */
  ready: boolean;
  afterMerged: number[];
  riskTier: MergeBatchRiskTier;
  /** Advisory CI selection; required checks and security gates always remain. */
  ci: 'targeted' | 'full';
  job: MergeBatchRebaseJob | null;
}

export interface MergeBatchRunInput {
  plan: MergeBatchPlan;
  /** The SAME parsed snapshot used to make plan; supplies complete files and heads. */
  prs: readonly MergeBatchPr[];
  snapshotComplete?: boolean;
  hold?: ReadonlySet<string>;
  existing?: readonly RebasePlanExistingJob[];
  testsImportingTier1?: ReadonlySet<string>;
}

export interface MergeBatchRun {
  schema: typeof MERGE_BATCH_RUN_SCHEMA;
  v: 1;
  repo: string | null;
  generatedAt: string;
  counts: Record<MergeBatchActionKind, number>;
  actions: MergeBatchAction[];
}

const completeFiles = (pr: MergeBatchPr): boolean => pr.filesComplete !== false
  && pr.files.length > 0 && pr.files.length < MAX_FILES_PER_PR
  && pr.files.every(file => normalizeRepoPath(file) !== null);

/** Path evidence only: targeted tests still run, and diff-level tamper checks still apply. */
export function classifyMergeBatchRisk(pr: MergeBatchPr, testsImportingTier1?: ReadonlySet<string>): MergeBatchRiskTier {
  if (!completeFiles(pr)) return 'unknown';
  if (pr.files.some(file => matchProtectedPath(file, { selfRepo: true, testsImportingTier1 }) !== null
    || securityPinnedPath(file))) return 'protected';
  return pr.files.every(file => isTestPath(file) || /\.(?:md|mdx|rst|txt)$/i.test(file)) ? 'low' : 'standard';
}

/**
 * Compile one bounded plan. Dependencies are recomputed from actual files in
 * planned order, so even disjoint clean members of one component can run at
 * once. Each file remembers its last predecessor: transitive dependencies
 * serialize overlap without a quadratic dependency list. Replan after a merge
 * or rebase; a WAITING job must never run against the old base.
 */
export function runMergeBatch(input: MergeBatchRunInput): MergeBatchRun {
  const { plan, prs } = input;
  if (plan.schema !== MERGE_BATCH_SCHEMA || plan.v !== 1 || prs.length > MAX_PRS
    || plan.order.length !== prs.length || plan.batches.length > MAX_PRS
    || plan.batches.reduce((count, batch) => count + batch.prs.length, 0) !== prs.length
    || (input.existing?.length ?? 0) > MAX_PRS) throw new Error('invalid or oversized merge batch');
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  const members = plan.batches.flatMap(batch => batch.prs.map(pr => ({ batch: batch.id, pr })));
  if (byNumber.size !== prs.length || new Set(plan.order).size !== prs.length
    || new Set(members.map(m => m.pr.number)).size !== prs.length
    || plan.order.some(n => !byNumber.has(n))) throw new Error('plan/snapshot membership mismatch');
  const planned = new Map(members.map(m => [m.pr.number, m]));
  for (const pr of prs) {
    const member = planned.get(pr.number)?.pr;
    if (!member || member.headRef !== pr.headRef || member.mergeStateStatus !== pr.mergeStateStatus
      || member.isDraft !== pr.isDraft || member.fileCount !== pr.files.length
      || member.conflicted !== (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY')) {
      throw new Error('plan/snapshot evidence mismatch');
    }
  }
  const repo = plan.repo;
  const short = repo?.split('/').pop();
  const usable = input.snapshotComplete !== false && plan.counts.unreadable === 0 && plan.counts.duplicates === 0;
  // Explicit recut/rebase identities only: common titles or file overlap never prove supersession.
  const superseded = reworkSuperseded(prs.filter(pr => !pr.isDraft), repo);
  const spent = rebaseAttemptsSpent(prs, repo);
  const replacements = rebaseAttemptsSpent(prs.filter(pr => !pr.isDraft), repo);
  const covered = coveredPrNumbers(input.existing ?? [], repo);
  const lastByFile = new Map<string, number>();
  const actions: MergeBatchAction[] = [];
  const counts: MergeBatchRun['counts'] = { 'enqueue-merge': 0, rebase: 0, 'close-review': 0, wait: 0 };
  for (const number of plan.order) {
    const pr = byNumber.get(number)!;
    const member = planned.get(number)!;
    const files = pr.files.slice(0, MAX_FILES_PER_PR).map(normalizeRepoPath).filter((p): p is string => p !== null);
    const afterMerged = [...new Set(files.flatMap(file => {
      const previous = lastByFile.get(file.toLowerCase());
      return previous === undefined ? [] : [previous];
    }))].sort((a, b) => a - b);
    const riskTier = classifyMergeBatchRisk(pr, input.testsImportingTier1);
    const action: MergeBatchAction = { number, batch: member.batch, headSha: pr.headSha,
      kind: 'wait', reason: 'unknown-mergeability', ready: false, afterMerged,
      riskTier, ci: riskTier === 'low' ? 'targeted' : 'full', job: null };
    const held = input.hold?.has(`${repo}#${number}`) || input.hold?.has(`${short}#${number}`) || input.hold?.has(`*#${number}`);
    if (!usable) action.reason = 'incomplete-snapshot';
    else if (!repo || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) action.reason = 'missing-repo';
    else if (held) action.reason = 'held';
    else if (pr.supersededBy !== undefined && Number.isSafeInteger(pr.supersededBy) && pr.supersededBy > 0 && pr.supersededBy !== number) {
      action.kind = 'close-review'; action.reason = `superseded-by-merged-pr:${pr.supersededBy}`;
    } else if (superseded.has(number) || replacements.get(number)?.reason === 'already-rebased') {
      action.kind = 'close-review'; action.reason = 'open-replacement';
    } else if (pr.isDraft) action.reason = 'draft';
    else if (covered.has(number)) action.reason = 'active-job';
    else if (!completeFiles(pr)) action.reason = 'incomplete-files';
    else if (!pr.headSha || !/^[0-9a-f]{40}$/i.test(pr.headSha)) action.reason = 'missing-head-sha';
    else if (pr.mergeStateStatus === 'BLOCKED') action.reason = 'blocked';
    else if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'
      || pr.mergeStateStatus === 'BEHIND' || afterMerged.length > 0) {
      if (spent.has(number)) action.reason = 'rebase-attempt-spent';
      else if (!/^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/.test(pr.headRef) || pr.headRef.includes('..')) action.reason = 'invalid-head-ref';
      else {
        action.kind = 'rebase';
        action.reason = afterMerged.length > 0 ? 'after-overlapping-merges' : 'base-sync-required';
        action.ready = afterMerged.length === 0;
        action.job = { id: `RQ-REBASE-${short}-${number}-${pr.headSha.slice(0, 7).toLowerCase()}`,
          repo, number, headRef: pr.headRef, headSha: pr.headSha, pool: 'any', tier: 'work',
          status: action.ready ? 'READY' : 'WAITING', afterMerged,
          securityPinRequired: riskTier === 'protected' };
      }
    } else if (pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'CLEAN') {
      action.kind = 'enqueue-merge'; action.reason = 'clean-wave'; action.ready = true;
    }
    if (action.kind !== 'close-review') for (const file of files) lastByFile.set(file.toLowerCase(), number);
    actions.push(action);
    counts[action.kind] += 1;
  }
  return { schema: MERGE_BATCH_RUN_SCHEMA, v: 1, repo, generatedAt: plan.generatedAt, counts, actions };
}
