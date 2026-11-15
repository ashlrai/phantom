/**
 * Merge autopilot (RQ-MERGEAUTOPILOTQ7) — `phm land auto`.
 *
 * One bounded sweep over the fleet's open pull requests (the fleet-merge-state
 * records a standing pass opened). Each PR is read live from GitHub and
 * classified into exactly one class, then — under `--apply` — acted on:
 *
 *   green-ready    every required check green and mergeable — nothing to do;
 *                  the standing merge pass lands these itself
 *   behind         base moved ahead (`mergeable_state` behind, or the base
 *                  head no longer the recorded base) → GitHub's update-branch
 *                  effect merges the base into the head (MERGE METHOD ONLY —
 *                  the REST endpoint has no rebase), pinned to the recorded
 *                  head SHA so a push between classify and call is a refusal
 *   conflicting    GitHub reports a merge conflict (`dirty`) → enqueue a
 *                  DRAIN task that rebases/merges the branch clean
 *   red-required   G7 sees a required check fail → enqueue a FIXUP task that
 *                  names the first failing required check
 *   pending        required checks still running — wait
 *   blocked        blocked by something checks cannot fix (draft, review,
 *                  a checks timeout) — reported, never acted on
 *   closed         merged or closed on GitHub — the pass reconciles it
 *   held           repo hold, owner lane, unledgered open, or a G7 owner-lane
 *                  outcome — the autopilot never touches these
 *   moved          the head SHA drifted from the recorded verified head —
 *                  the fleet never acts on a head it did not verify
 *   unknown        GitHub could not be read — FAIL CLOSED: no action
 *
 * Safety shape (spec, frozen):
 *   - dry-run by default; `--apply` also needs PHANTOM_MERGE_AUTOPILOT=1
 *   - never --admin, never --rebase, never a force-push, never check skipping:
 *     the only GitHub effect is update-branch (server-side merge of the base)
 *   - the repo hold list (quarantine.ts) is honored and unreadable holds fail
 *     the whole run closed
 *   - per-PR cap: at most AUTOPILOT_MAX_ACTIONS_PER_PR (3) actions inside a
 *     rolling 24 h window, remembered on the merge-state record itself
 *
 * Every dependency is injectable (MergeAutopilotDeps) so classification, the
 * cap, holds and failures are tested without GitHub, a policy or a queue.
 */
import type {
  AutopilotActionKind,
  FleetMergeStateV1,
} from './fleet-merge-state.js';
import {
  AUTOPILOT_MAX_ACTIONS_PER_PR,
  autopilotActionBudget,
  listFleetMergeStateKeys,
  lockFleetMergeState,
  readFleetMergeState,
  recordAutopilotAction,
  unlockFleetMergeState,
  writeFleetMergeState,
} from './fleet-merge-state.js';
import {
  defaultHostMergeDeps,
  FLEET_APP_BOT_LOGIN,
  OWNER_LANE_LABEL,
  readBranchHead,
  readHeadChecks,
  readPr,
  readRequiredChecks,
  updateFleetPrBranch,
  type HostMergeDeps,
} from './host-merge.js';
import {
  evaluateG7Checks,
  runState,
  statusState,
  type CheckRunObservation,
  type RequiredCheck,
  type StatusObservation,
} from './merge-gates.js';
import { listRepoHolds } from './quarantine.js';
import { enqueueTask } from './task-source.js';
import { scrubSecrets } from '../util/scrub.js';
import type {
  EnqueueTaskResult,
  FleetTaskInput,
  RepoEnforcement,
  RepoHold,
} from './fleet-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MergeAutopilotClass =
  | 'green-ready'
  | 'behind'
  | 'conflicting'
  | 'red-required'
  | 'pending'
  | 'blocked'
  | 'closed'
  | 'held'
  | 'moved'
  | 'unknown';

export type MergeAutopilotActionStatus = 'planned' | 'applied' | 'failed' | 'skipped' | 'duplicate';

export interface MergeAutopilotAction {
  kind: AutopilotActionKind;
  status: MergeAutopilotActionStatus;
  detail: string;
}

export interface MergeAutopilotPr {
  /** Fleet merge-state key (the proposal / revert record the PR lives on). */
  key: string;
  repo: string;
  number: number;
  headSha: string;
  baseBranch: string;
  class: MergeAutopilotClass;
  /** Why — one sentence (a hold reason, a failing check, a GitHub error). */
  detail: string;
  /** red-required only: the first failing required check, null when unreadable. */
  firstFailingCheck: string | null;
  /** What the run did (apply) or would do (dry-run `planned`) for this class. */
  action: MergeAutopilotAction | null;
}

export interface MergeAutopilotResult {
  ok: boolean;
  apply: boolean;
  /** Run-level refusal (unreadable holds / state store, --apply unarmed); null when ok. */
  reason: string | null;
  prs: MergeAutopilotPr[];
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The env flag that arms --apply; injected so tests never see the real env. */
export function mergeAutopilotArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['PHANTOM_MERGE_AUTOPILOT'] === '1';
}

export interface MergeAutopilotDeps {
  /** GitHub reads + the update-branch effect (host-merge.ts). */
  host?: HostMergeDeps;
  /** Active repo holds; the default THROWS on an unreadable store (fail closed). */
  listHolds?: () => RepoHold[];
  /** The fleet's task queue (task-source.ts). */
  enqueue?: (input: FleetTaskInput) => EnqueueTaskResult;
  /** The PHANTOM_MERGE_AUTOPILOT=1 gate; the default reads the real env. */
  armed?: () => boolean;
  nowMs?: () => number;
  /** Fleet merge-state keys; the default lists the real store. */
  stateKeys?: () => string[] | null;
}

export interface MergeAutopilotOptions {
  /** Restrict the sweep to one repo (owner/name, case-insensitive). */
  repo?: string;
  /** Act on the classes that have a remedy. Default false = classify only. */
  apply?: boolean;
  deps?: MergeAutopilotDeps;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const ACTION_OF_CLASS = {
  behind: 'update-branch',
  conflicting: 'drain-task',
  'red-required': 'fixup-task',
} as const satisfies Partial<Record<MergeAutopilotClass, AutopilotActionKind>>;

const ACTABLE_CLASSES = new Set<MergeAutopilotClass>(Object.keys(ACTION_OF_CLASS) as MergeAutopilotClass[]);

/**
 * The post-read class of one live PR. Order matters — each line claims the
 * PR before the next is considered:
 *
 *   conflicting first (update-branch is refused on conflicts anyway), then
 *   behind (the cheapest nudge: it also re-runs every required check on the
 *   merged head, so a stale red is re-proven before a FIXUP is filed), then
 *   red-required, then green-ready.
 */
export function classifyMergeAutopilotPr(input: {
  mergeable: boolean | null;
  mergeableState: string;
  /** The base branch's live head is not the recorded verified base. */
  baseMoved: boolean;
  /** G7's read of required checks, or 'unreadable' when GitHub refused it. */
  checks: 'unreadable' | { state: 'green' | 'red' | 'pending' | 'none'; code: string };
}): MergeAutopilotClass {
  const { mergeable, mergeableState, baseMoved, checks } = input;
  if (mergeableState === 'dirty' || mergeable === false) return 'conflicting';
  if (mergeableState === 'behind' || baseMoved) return 'behind';
  if (checks === 'unreadable') return 'unknown';
  if (checks.state === 'red' && checks.code === 'required-check-failed') return 'red-required';
  if (checks.state === 'none') return 'held';
  if (checks.state === 'red') return 'blocked';
  if (checks.state === 'green') {
    return mergeableState === 'blocked' || mergeableState === 'draft' ? 'blocked' : 'green-ready';
  }
  return 'pending';
}

/**
 * The first failing required check, in G7's exact read: a red run OR status
 * observed for a required context (sorted by context — deterministic). Under
 * local enforcement every observed check is required, so the first red name
 * wins. Null when nothing required is red (or nothing to inspect).
 */
export function firstFailingRequiredCheck(
  enforcement: RepoEnforcement,
  required: readonly RequiredCheck[],
  runs: readonly CheckRunObservation[],
  statuses: readonly StatusObservation[],
): string | null {
  const latestByKey = new Map<string, CheckRunObservation>();
  for (const run of runs) {
    const key = `${run.name}\0${run.appId ?? ''}`;
    const prior = latestByKey.get(key);
    if (!prior || run.id > prior.id) latestByKey.set(key, run);
  }
  const latestRuns = [...latestByKey.values()];
  if (enforcement === 'local') {
    const reds = [
      ...latestRuns.filter((run) => runState(run) === 'red').map((run) => run.name),
      ...statuses.filter((status) => statusState(status) === 'red').map((status) => status.context),
    ];
    return reds.sort((a, b) => a.localeCompare(b))[0] ?? null;
  }
  for (const req of required) {
    const reqRuns = latestRuns.filter((run) => run.name === req.context && (req.appId === null || run.appId === req.appId));
    const reqStatuses = req.appId === null ? statuses.filter((status) => status.context === req.context) : [];
    const observed = [...reqRuns.map(runState), ...reqStatuses.map(statusState)];
    if (observed.includes('red')) return req.context;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tasks the autopilot enqueues
// ---------------------------------------------------------------------------

/** A DRAIN task: work that shrinks the open-PR pile — the land-first 'land' class. */
function drainTaskInput(repo: string, record: FleetMergeStateV1): FleetTaskInput {
  const pr = record.pr!;
  return {
    repo,
    source: 'manual',
    title: `Land PR #${pr.number} (${repo}): resolve merge conflicts with ${pr.baseBranch}`,
    detail:
      `Merge autopilot: fleet PR #${pr.number} on ${repo} (head ${pr.headSha.slice(0, 12)}) conflicts with ${pr.baseBranch}. ` +
      `Check out the PR branch, merge ${pr.baseBranch} into it and resolve the conflicts, push, and leave every ` +
      'required check green. Do not force-push or rewrite the branch history. ' +
      'Repository instructions and supervisor security rules apply.',
    difficulty: 'medium',
    value: 4,
    requestedBy: 'daemon',
    dedupeKey: `merge-autopilot:drain:${repo}:pr-${pr.number}`,
  };
}

/** A FIXUP task: repair the work already on the PR's branch — the land-first 'fixup' class. */
function fixupTaskInput(repo: string, record: FleetMergeStateV1, failingCheck: string | null): FleetTaskInput {
  const pr = record.pr!;
  const check = failingCheck ?? 'a required check';
  return {
    repo,
    source: 'manual',
    title: `FIXUP PR #${pr.number} (${repo}): required check ${check} failed`,
    detail:
      `Merge autopilot: fleet PR #${pr.number} on ${repo} (head ${pr.headSha.slice(0, 12)}) is red: ` +
      `the first failing required check is ${check}. Reproduce the failure on the PR branch, fix the root cause, ` +
      'push, and leave every required check green. Do not force-push or rewrite the branch history. ' +
      'Repository instructions and supervisor security rules apply.',
    difficulty: 'medium',
    value: 4,
    requestedBy: 'daemon',
    dedupeKey: `merge-autopilot:fixup:${repo}:pr-${pr.number}`,
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

function clean(text: string, max: number): string {
  const flat = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isPrCandidate(record: FleetMergeStateV1, repoFilter: string | undefined): boolean {
  const pr = record.pr;
  if (!pr || pr.state !== 'open' || record.outcome !== null) return false;
  if (repoFilter !== undefined && record.repo.toLowerCase() !== repoFilter.toLowerCase()) return false;
  return true;
}

/** Remember one applied act on the record, under its cross-process lock. False = the cap bookkeeping was lost. */
function recordAction(key: string, kind: AutopilotActionKind, detail: string | null, nowIso: string): boolean {
  const lock = lockFleetMergeState(key);
  if (!lock) return false;
  try {
    const read = readFleetMergeState(key);
    if (read.state !== 'ok') return false;
    recordAutopilotAction(read.record, kind, detail, nowIso);
    return writeFleetMergeState(read.record);
  } finally {
    unlockFleetMergeState(lock);
  }
}

async function classifyRecord(
  record: FleetMergeStateV1,
  holds: readonly RepoHold[],
  host: HostMergeDeps,
  nowMs: number,
): Promise<Omit<MergeAutopilotPr, 'action'>> {
  const pr = record.pr!;
  const row: Omit<MergeAutopilotPr, 'action'> = {
    key: record.key,
    repo: record.repo,
    number: pr.number,
    headSha: pr.headSha,
    baseBranch: pr.baseBranch,
    class: 'unknown',
    detail: '',
    firstFailingCheck: null,
  };
  // The hold list, the owner lane and the ledgering invariant: never touched.
  if (pr.ownerLane) return { ...row, class: 'held', detail: clean(pr.ownerLaneReason ?? 'the PR is in the owner lane', 200) };
  const repoHolds = holds.filter((hold) => hold.repo.toLowerCase() === record.repo.toLowerCase());
  if (repoHolds.length > 0) {
    return { ...row, class: 'held', detail: clean(repoHolds.map((h) => `${h.kind} hold: ${h.reason}`).join('; '), 300) };
  }
  if (!pr.ledgered) return { ...row, class: 'held', detail: "the PR's opening is not ledgered yet" };

  const live = await readPr(record.repo, pr.number, host);
  if (typeof live === 'string') return { ...row, class: 'unknown', detail: clean(live, 200) };
  if (live.merged) return { ...row, class: 'closed', detail: 'merged on GitHub' };
  if (live.state !== 'open') return { ...row, class: 'closed', detail: 'closed on GitHub' };
  if (live.headSha !== pr.headSha) {
    return { ...row, class: 'moved', detail: `the head moved to ${live.headSha.slice(0, 12)} outside the fleet; it goes to the owner lane` };
  }
  if (live.labels.includes(OWNER_LANE_LABEL)) return { ...row, class: 'held', detail: `labelled ${OWNER_LANE_LABEL} on GitHub` };
  if (live.authorLogin !== FLEET_APP_BOT_LOGIN) return { ...row, class: 'held', detail: `not authored by ${FLEET_APP_BOT_LOGIN}` };

  // Conflicting and behind classify without a checks read (cheap and decisive).
  if (live.mergeableState === 'dirty' || live.mergeable === false) {
    return { ...row, class: 'conflicting', detail: `conflicts with ${pr.baseBranch}` };
  }
  const baseHead = await readBranchHead(record.repo, pr.baseBranch, host);
  if (typeof baseHead === 'string') return { ...row, class: 'unknown', detail: clean(baseHead, 200) };
  if (baseHead.sha === null) return { ...row, class: 'unknown', detail: `base branch ${pr.baseBranch} is gone` };
  const baseMoved = baseHead.sha !== pr.baseSha;
  if (live.mergeableState === 'behind' || baseMoved) {
    return { ...row, class: 'behind', detail: `behind ${pr.baseBranch}${live.mergeableState === 'behind' ? ' (GitHub requires up-to-date branches)' : ''}` };
  }

  const enforcement = record.enforcement ?? 'server';
  // Server enforcement needs GitHub's required-checks list; local enforces
  // every observed check + the App's ashlr/verify, so the rulesets read is
  // skipped (its failure must not blind a repo that never uses it).
  let requiredList: readonly RequiredCheck[] = [];
  let rulesetsUnavailable = false;
  if (enforcement === 'server') {
    const required = await readRequiredChecks(record.repo, pr.baseBranch, host);
    if (typeof required === 'string') return { ...row, class: 'unknown', detail: clean(required, 200) };
    requiredList = required.required;
    rulesetsUnavailable = required.rulesetsUnavailable;
  }
  const checks = await readHeadChecks(record.repo, pr.headSha, host);
  if (typeof checks === 'string') return { ...row, class: 'unknown', detail: clean(checks, 200) };
  const g7 = evaluateG7Checks({
    enforcement,
    required: requiredList,
    runs: checks.runs,
    statuses: checks.statuses,
    pendingSinceMs: Date.parse(pr.openedAt) || nowMs,
    nowMs,
    fleetAppId: pr.verifyCheck?.appId ?? null,
    rulesetsUnavailable,
  });
  const cls = classifyMergeAutopilotPr({
    mergeable: live.mergeable,
    mergeableState: live.mergeableState,
    baseMoved: false,
    checks: { state: g7.state, code: g7.code },
  });
  if (cls === 'red-required') {
    return {
      ...row,
      class: cls,
      detail: clean(g7.reason, 200),
      firstFailingCheck: firstFailingRequiredCheck(enforcement, requiredList, checks.runs, checks.statuses),
    };
  }
  return { ...row, class: cls, detail: clean(g7.reason, 200) };
}

async function act(
  row: Omit<MergeAutopilotPr, 'action'>,
  record: FleetMergeStateV1,
  apply: boolean,
  enqueue: (input: FleetTaskInput) => EnqueueTaskResult,
  host: HostMergeDeps,
  nowMs: number,
): Promise<MergeAutopilotAction | null> {
  const kind = ACTION_OF_CLASS[row.class as keyof typeof ACTION_OF_CLASS] ?? null;
  if (kind === null || !ACTABLE_CLASSES.has(row.class)) return null;
  const planned: Record<AutopilotActionKind, string> = {
    'update-branch': `gh pr update-branch — merge ${row.baseBranch} into the head`,
    'drain-task': 'enqueue a DRAIN task to resolve the conflicts',
    'fixup-task': `enqueue a FIXUP task for ${row.firstFailingCheck ?? 'the failing required check'}`,
  };
  const budget = autopilotActionBudget(record, nowMs);
  if (budget <= 0) {
    return { kind, status: 'skipped', detail: `cap reached: ${AUTOPILOT_MAX_ACTIONS_PER_PR} actions in 24 h` };
  }
  if (!apply) return { kind, status: 'planned', detail: planned[kind] };
  const nowIso = new Date(nowMs).toISOString();
  // The effect landed but its memo did not — say so; a silent miss would
  // understate the 24 h cap next run.
  const memoNote = (memoRecorded: boolean): string => memoRecorded ? '' : ' (the action memo could not be recorded; the 24 h cap may undercount)';
  if (kind === 'update-branch') {
    const result = await updateFleetPrBranch({ repo: row.repo, number: row.number, expectedHeadSha: row.headSha }, host);
    if (!result.ok) return { kind, status: 'failed', detail: clean(result.reason, 200) };
    const recorded = recordAction(row.key, kind, result.reason, nowIso);
    return { kind, status: 'applied', detail: `${clean(result.reason, 200)}${memoNote(recorded)}` };
  }
  const input = kind === 'drain-task' ? drainTaskInput(row.repo, record) : fixupTaskInput(row.repo, record, row.firstFailingCheck);
  let result: EnqueueTaskResult;
  try {
    result = enqueue(input);
  } catch (error) {
    return { kind, status: 'failed', detail: clean(error instanceof Error ? error.message : String(error), 200) };
  }
  if (!result.ok) return { kind, status: 'failed', detail: clean(result.reason, 200) };
  if (result.deduped) return { kind, status: 'duplicate', detail: `already queued as task ${result.task.id}` };
  const recorded = recordAction(row.key, kind, `task ${result.task.id}`, nowIso);
  return { kind, status: 'applied', detail: `queued task ${result.task.id}${memoNote(recorded)}` };
}

/**
 * One sweep: classify every open fleet PR, then act on it when `apply` is on.
 * Nothing runs unless `apply` is true AND the autopilot is armed
 * (PHANTOM_MERGE_AUTOPILOT=1). Unknown state always fails closed.
 */
export async function runMergeAutopilot(opts: MergeAutopilotOptions = {}): Promise<MergeAutopilotResult> {
  const deps = opts.deps ?? {};
  const apply = opts.apply === true;
  const fail = (reason: string): MergeAutopilotResult => ({ ok: false, apply, reason, prs: [] });

  const armed = (deps.armed ?? (() => mergeAutopilotArmed()))();
  if (apply && !armed) {
    return fail('--apply needs PHANTOM_MERGE_AUTOPILOT=1 in the environment; without it `land auto` only classifies.');
  }
  let holds: RepoHold[];
  try {
    holds = (deps.listHolds ?? listRepoHolds)();
  } catch (error) {
    return fail(`the repo hold list could not be read (${clean(error instanceof Error ? error.message : String(error), 200)}); nothing was classified or touched`);
  }
  const keys = (deps.stateKeys ?? listFleetMergeStateKeys)();
  if (keys === null) return fail('the fleet merge-state directory could not be listed; nothing was classified or touched');

  const host = deps.host ?? defaultHostMergeDeps();
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const enqueue = deps.enqueue ?? enqueueTask;
  const prs: MergeAutopilotPr[] = [];
  for (const key of [...keys].sort()) {
    const read = readFleetMergeState(key);
    // missing/corrupt: never act on unknown state — skip without a row.
    if (read.state !== 'ok') continue;
    const record = read.record;
    if (!isPrCandidate(record, opts.repo)) continue;
    const row = await classifyRecord(record, holds, host, nowMs);
    const action = await act(row, record, apply, enqueue, host, nowMs);
    prs.push({ ...row, action });
  }
  return { ok: true, apply, reason: null, prs };
}
