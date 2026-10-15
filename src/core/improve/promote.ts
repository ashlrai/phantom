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
import { detectTestTampering, globMatches, protectedPathHits } from '../authority/protected-paths.js';
import type { MetricSpec, ProposalOutcome } from './outcomes.js';

export type PromoteExec = (cmd: string, args: string[], cwd: string) => string;
const realExec: PromoteExec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/**
 * Git with repository hooks, fsmonitor, external diff drivers and textconv off:
 * a PR head (or a hook path it ships) must not run code with this process's
 * credentials just because the gate looked at it.
 */
export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external='] as const;

/** Branch prefixes owned by Phantom's own improvement agents. Other owners' PRs are never promoted. */
export const PROMOTABLE_BRANCH_PREFIXES = ['improve/', 'ashlr-cloud/'] as const;

/**
 * Paths a promoted PR may never touch, on top of the authority owner lane
 * (`protectedPathHits`): the promotion gate itself, the autopilot that drives
 * PRs to it, Stop/Pause, and the governance documents that admit it. A
 * self-improvement PR that edits the gate would grade every later PR with the
 * gate it wrote.
 */
export const PROMOTION_PROTECTED_PATTERNS: readonly string[] = Object.freeze([
  'src/core/improve/**', 'src/cli/improve.ts', 'src/core/autopilot/**', 'src/cli/autopilot.ts',
  'src/core/comms/pause.ts', 'src/core/sandbox/**', 'src/core/authority/**', 'src/core/inbox/merge.ts',
  'CONSTITUTION.md', 'AGENTS.md', '**/CLAUDE.md', 'SECURITY.md',
]);

export interface PrCheck { name: string; state: 'success' | 'skipped' | 'pending' | 'failure' }
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

/** Stop/Pause as read at decision time. Either one refuses promotion outright. */
export interface PromotionGuards { killSwitch: boolean; paused: boolean }

/** What the PR changes between its merge base and head, as the gate itself read it from git. */
export interface DiffEvidence {
  /** Every path the diff names, renames split into delete + add. */
  paths: string[];
  /** The unified diff text (for test-tamper scanning). */
  patch: string;
}

/** The gate's own fresh measurement of the metric at the merge base and head; never taken from the ledger. */
export interface Remeasurement { base: number | null; head: number | null; reasons: string[] }

export const NOT_REMEASURED = 'the gate has not re-measured the metric itself yet';

/** Why a diff may not be promoted without a person: owner-lane paths, the gate's own code, test tampering, a self-edited metric. */
export function diffRefusals(diff: DiffEvidence, metric: MetricSpec | undefined): string[] {
  const reasons: string[] = [];
  if (!diff.paths.length) reasons.push('the PR changes nothing between its merge base and head');
  for (const hit of protectedPathHits(diff.paths, { selfRepo: true }).slice(0, 5)) reasons.push(`touches ${hit.path}: ${hit.why}`);
  const gate = diff.paths.filter((p) => PROMOTION_PROTECTED_PATTERNS.some((g) => globMatches(g, p)));
  if (gate.length) reasons.push(`touches the promotion gate or its governance (${gate.slice(0, 5).join(', ')}); a person reviews those`);
  if (metric?.runner.kind === 'node') {
    const runner = metric.runner.path.toLowerCase();
    if (diff.paths.some((p) => p.toLowerCase() === runner)) reasons.push(`changes its own metric script ${metric.runner.path}; the yardstick must come from the base`);
  }
  if (diff.patch.trim()) {
    const scan = detectTestTampering(diff.patch);
    if (scan.parseError) reasons.push(`diff could not be checked for test tampering: ${scan.parseError}`);
    for (const f of scan.findings.slice(0, 5)) reasons.push(`weakens tests: ${f.detail}`);
  }
  return reasons;
}

export function evaluatePromotion(input: {
  outcome: ProposalOutcome | undefined;
  pr: PrSnapshot;
  defaultBranch: string;
  mergeBase: string;
  ledgerIntact: boolean;
  guards: PromotionGuards;
  diff: DiffEvidence;
  /** Absent until the gate measures; promotion is never admitted without it. */
  remeasured?: Remeasurement;
}): PromotionDecision {
  const { outcome, pr } = input;
  const reasons: string[] = [];
  if (input.guards.killSwitch) reasons.push('the autonomy kill switch is on');
  if (input.guards.paused) reasons.push('Phantom is paused');
  if (!input.ledgerIntact) reasons.push('outcome ledger is not intact');
  if (!outcome) reasons.push('no registered proposal with a declared metric');
  if (pr.state !== 'OPEN') reasons.push(`PR is ${pr.state.toLowerCase()}, not open`);
  if (pr.isCrossRepository) reasons.push('PR head is in another repository');
  if (!PROMOTABLE_BRANCH_PREFIXES.some((p) => pr.headRefName.startsWith(p))) reasons.push(`branch ${pr.headRefName} is not owned by the improvement loop`);
  if (pr.baseRefName !== input.defaultBranch) reasons.push(`PR targets ${pr.baseRefName}, not the default branch ${input.defaultBranch}`);
  if (!pr.checks.length) reasons.push('no checks reported on the head commit');
  else if (!pr.checks.some((c) => c.state === 'success')) reasons.push('no check actually passed on the head commit (all skipped or neutral)');
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
  reasons.push(...diffRefusals(input.diff, outcome?.metric));
  const fresh = input.remeasured;
  if (!fresh) reasons.push(NOT_REMEASURED);
  else if (outcome) {
    // The ledger is a local file any same-user process can extend with a valid digest chain,
    // so its numbers are claims. Only the gate's own run at the exact commits counts.
    if (fresh.base === null || fresh.head === null) reasons.push(`gate re-measurement is unknown (${fresh.reasons.join('; ') || 'no value'})`);
    else {
      if (outcome.base && fresh.base !== outcome.base.value) reasons.push(`recorded base value ${outcome.base.value} does not reproduce (gate measured ${fresh.base})`);
      if (outcome.head && fresh.head !== outcome.head.value) reasons.push(`recorded head value ${outcome.head.value} does not reproduce (gate measured ${fresh.head})`);
      const effect = (outcome.metric.direction === 'increase' ? 1 : -1) * (fresh.head - fresh.base);
      if (!(effect > 0)) reasons.push(`gate re-measurement shows no improvement (${fresh.base} -> ${fresh.head})`);
    }
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
    return { name: String(c.name ?? 'check'), state: k === 'SUCCESS' ? 'success' : k === 'NEUTRAL' || k === 'SKIPPED' ? 'skipped' : 'failure' };
  });
}

export function readPr(repository: string, number: number, repoDir: string, exec: PromoteExec = realExec): PrSnapshot {
  const raw = JSON.parse(exec('gh', ['pr', 'view', String(number), '--repo', repository, '--json',
    'number,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,statusCheckRollup'], repoDir)) as Record<string, unknown>;
  return { number: Number(raw.number), state: String(raw.state), isDraft: raw.isDraft === true, isCrossRepository: raw.isCrossRepository !== false,
    headRefName: String(raw.headRefName ?? ''), headRefOid: String(raw.headRefOid ?? ''), baseRefName: String(raw.baseRefName ?? ''),
    checks: normalizeChecks(raw.statusCheckRollup) };
}

/**
 * The repository's default branch as GitHub reports it. The local
 * `origin/HEAD` is not used: any local process can repoint it with
 * `git remote set-head`, which would let a PR into another branch pass the
 * "targets the default branch" check.
 */
export function defaultBranchOf(repository: string, repoDir: string, exec: PromoteExec = realExec): string {
  const name = exec('gh', ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], repoDir).trim();
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(name) || name.startsWith('-')) throw new Error('GitHub did not report an exact default branch.');
  return name;
}

/** The local checkout's `origin` must be the PR's repository, or every git fact below is about another repo. */
export function assertOriginIs(repository: string, repoDir: string, exec: PromoteExec = realExec): void {
  const url = exec('git', [...SAFE_GIT, 'remote', 'get-url', 'origin'], repoDir).trim();
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (!m || m[1]!.toLowerCase() !== repository.toLowerCase()) throw new Error(`--repo checkout's origin is not github.com/${repository}`);
}

/** Exact merge base of the PR head with the current default branch, after fetching both. */
export function prMergeBase(repoDir: string, pr: PrSnapshot, defaultBranch: string, exec: PromoteExec = realExec): string {
  if (!/^[0-9a-f]{40}$/.test(pr.headRefOid)) throw new Error('GitHub did not report an exact head commit.');
  exec('git', [...SAFE_GIT, 'fetch', '--no-tags', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`, `refs/pull/${pr.number}/head`], repoDir);
  const base = exec('git', [...SAFE_GIT, 'merge-base', `refs/remotes/origin/${defaultBranch}`, pr.headRefOid], repoDir).trim();
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('Could not resolve an exact merge base.');
  return base;
}

/** The PR's change as git reports it between two exact commits, without renames (a rename is a delete plus an add). */
export function prDiff(repoDir: string, base: string, head: string, exec: PromoteExec = realExec): DiffEvidence {
  const range = [base, head];
  const names = exec('git', [...SAFE_GIT, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', ...range], repoDir);
  const patch = exec('git', [...SAFE_GIT, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', ...range], repoDir);
  return { paths: names.split('\0').filter(Boolean), patch };
}

/** Queue the merge on GitHub. Required checks and branch protection still apply there. */
export function queueMerge(repository: string, pr: PrSnapshot, repoDir: string, exec: PromoteExec = realExec): void {
  if (pr.isDraft) exec('gh', ['pr', 'ready', String(pr.number), '--repo', repository], repoDir);
  exec('gh', ['pr', 'merge', String(pr.number), '--repo', repository, '--squash', '--auto', '--match-head-commit', pr.headRefOid], repoDir);
}

/**
 * After queueing, the PR must still be the one the gate admitted. `--match-head-commit`
 * pins the head, but the base branch can be retargeted while auto-merge waits on
 * checks; a retarget or a new head disables auto-merge again.
 */
export function confirmQueued(repository: string, admitted: PrSnapshot, repoDir: string, exec: PromoteExec = realExec): string[] {
  const now = readPr(repository, admitted.number, repoDir, exec);
  const drift: string[] = [];
  if (now.headRefOid !== admitted.headRefOid) drift.push(`head moved to ${now.headRefOid.slice(0, 12)}`);
  if (now.baseRefName !== admitted.baseRefName) drift.push(`base retargeted to ${now.baseRefName}`);
  if (now.isCrossRepository) drift.push('head is now in another repository');
  if (drift.length) exec('gh', ['pr', 'merge', String(admitted.number), '--repo', repository, '--disable-auto'], repoDir);
  return drift;
}
