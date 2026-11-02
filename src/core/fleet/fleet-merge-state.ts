/**
 * Fleet merge state — V3.10 Track B (owner: unit U3).
 *
 * One small private record per fleet change (a proposal) or fleet revert,
 * under `~/.ashlr/authority/fleet-merge/` (dir 0700, files 0600). It holds
 * what the gates and the host merge must remember BETWEEN ticks: which gate
 * rows were already ledgered (so a proposal that waits 1,440 ticks for a judge
 * writes one `wait` row, not 1,440), the verified base / tree the PR head was
 * built from, the fleet PR, and the in-flight host-merge authority (so a Stop
 * in another process can find and revoke it).
 *
 * WHY here and not in the proposal record: `Proposal` is a frozen shared type
 * and its store has its own signed-envelope rules; and WHY under
 * `~/.ashlr/authority`: confinement denies that directory to every agent
 * (U2), so no agent can forge "this PR's head was verified" or "owner lane:
 * false". GitHub stays the source of truth for PR state — every decision that
 * matters re-reads it — this file only remembers what WE did.
 *
 * Fail directions: an unreadable record is reported as `corrupt` and the
 * caller skips that proposal (never "no state", which could re-open a PR or
 * re-run a merge). Writes are atomic and fsynced.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HostMergeRevocationIdentityV1 } from '../autonomy/host-merge-revocation-protocol.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLock, releaseLocalStoreLock, type LocalStoreLock } from './local-store-lock.js';
import type { VerifyCheckCommand, VerifyCheckMemo } from './verify-check-run.js';
import type {
  FleetActor,
  GateId,
  GateVerdict,
  JudgeId,
  LandingProducer,
  LandingRecord,
  MergeRisk,
  RepoEnforcement,
} from './fleet-types.js';

const STATE_VERSION = 1 as const;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_STATES = 4_096;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAME_WITH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** One ledgered gate row, remembered so an unchanged verdict is not re-appended every tick. */
export interface GateMemo {
  digest: string;
  verdict: GateVerdict;
  code: string;
  headSha: string | null;
  at: string;
}

/** What the last required-checks read said (G7). */
export interface ChecksMemo {
  state: 'green' | 'pending' | 'red' | 'none';
  detail: string;
  at: string;
}

export interface FleetPrMemo {
  number: number;
  /** GitHub node id (the host-merge protocol binds to it). */
  nodeId: string;
  repositoryId: string;
  branch: string;
  baseBranch: string;
  /** Parent of the head commit — the base the tree was verified on. */
  baseSha: string;
  headSha: string;
  treeSha: string;
  ownerLane: boolean;
  /** Why it is in the owner lane (protected path, no checks, head changed …); null when not. */
  ownerLaneReason: string | null;
  openedAt: string;
  /** `pr:opened` row written (a PR whose opening is not ledgered never merges). */
  ledgered: boolean;
  state: 'open' | 'closed' | 'merged';
  /** Who closed it; `github` = closed on GitHub by someone other than the fleet. */
  closedBy: FleetActor | 'github' | null;
  /** Earliest time to poll GitHub again (checks back off while CI runs). */
  nextCheckAt: string | null;
  checkBackoffMs: number;
  checks: ChecksMemo | null;
  /** Head SHA a `gate:would-merge` row was written for (once per head). */
  wouldMergeHeadSha: string | null;
  /**
   * 3.13: the `ashlr/verify` check run the App posted on a head (verify-check-run.ts).
   * Its `appId` is GitHub's own attribution of that run — the App id G7
   * requires `ashlr/verify` from on local-enforcement repos. Absent on
   * records written before 3.13 (treated as "never posted").
   */
  verifyCheck?: VerifyCheckMemo | null;
}

/** The host-merge authority for one merge attempt (host-merge-revocation-protocol). */
export interface MergeAttemptMemo {
  identity: HostMergeRevocationIdentityV1;
  operationPrefix: string;
  startedAt: string;
  phase: 'prepared' | 'armed' | 'consumed' | 'merged' | 'failed' | 'revoked';
  mergeSha: string | null;
  error: string | null;
  /**
   * The trailer values the merge call carries — kept so a crash between the
   * PUT and recording its answer can still build the exact LandingRecord from
   * what GitHub merged.
   */
  trailers: { grantId: string; gatesDigest: string; ledgerHead: string; stageId: string } | null;
}

export interface FleetMergeStateV1 {
  v: typeof STATE_VERSION;
  key: string;
  kind: 'change' | 'revert';
  /** null for a revert. */
  proposalId: string | null;
  /** For a revert: the landing it reverts; null for a change. */
  revertsLandingId: string | null;
  repo: string;
  /** The fleet mirror the work was verified in. */
  repoPath: string;
  enforcement: RepoEnforcement | null;
  createdAt: string;
  updatedAt: string;
  gates: Partial<Record<GateId, GateMemo>>;
  /** When G6 first had to wait for a judge seat (the 24 h widening clock); null = never waited. */
  judgeWaitSince: string | null;
  /** Last time this pass CALLED a judge for it (paid seats are never re-asked every tick). */
  judgeCalledAt?: string | null;
  /** Verification binding. */
  baseBranch: string | null;
  baseSha: string | null;
  treeSha: string | null;
  diffHash: string | null;
  verifyDigest: string | null;
  /** 3.13: the verify commands G3's verification ran (reported by `ashlr/verify`); absent before 3.13. */
  verifyCommands?: VerifyCheckCommand[] | null;
  /**
   * 3.14: the sibling-pin digest (fleet/mirrors.ts siblingPinsDigest) G3's
   * verification ran against; null/absent = no `file:../<sibling>` deps. The
   * pass re-verifies before publishing or merging when it no longer matches.
   */
  siblingPins?: string | null;
  risk: MergeRisk | null;
  files: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  producer: LandingProducer | null;
  judgeId: JudgeId | null;
  /**
   * 3.15: every judge whose ship G6 counted — two (different families) for a
   * two-judge producer such as Devin. Absent on records written before 3.15.
   */
  judgeIds?: JudgeId[] | null;
  /** Combined digest of the G0–G6 rows the PR was opened under. */
  openGatesDigest: string | null;
  pr: FleetPrMemo | null;
  merge: MergeAttemptMemo | null;
  landing: LandingRecord | null;
  /** `merge:landed` row written (reverts: U4 writes `revert:landed`, so this stays true once landed). */
  landingLedgered: boolean;
  /** Terminal disposition; null while in flight. */
  outcome: 'merged' | 'closed' | 'rejected' | null;
  outcomeReason: string | null;
}

export type FleetMergeStateRead =
  | { state: 'missing' }
  | { state: 'ok'; record: FleetMergeStateV1 }
  | { state: 'corrupt'; reason: string };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `~/.ashlr/authority/fleet-merge` — agent-unreadable under confinement (U2). */
export function fleetMergeStateDir(): string {
  return join(homedir(), '.ashlr', 'authority', 'fleet-merge');
}

/** The store key for a proposal (its id, when it is filename-safe). */
export function proposalStateKey(proposalId: string): string | null {
  return KEY_RE.test(proposalId) ? proposalId : null;
}

/** The store key for a revert, derived from U4's idempotency key (`revert:<landing.id>`). */
export function revertStateKey(idempotencyKey: string): string {
  return `revert-${createHash('sha256').update(`ashlr:fleet-revert-key:v1\0${idempotencyKey}`, 'utf8').digest('hex').slice(0, 40)}`;
}

function statePath(key: string): string {
  return join(fleetMergeStateDir(), `${key}.json`);
}

function lockPath(key: string): string {
  return join(fleetMergeStateDir(), `${key}.lock`);
}

function ensureStateDir(): { ok: true } | { ok: false; reason: string } {
  try {
    const dir = fleetMergeStateDir();
    const parent = join(homedir(), '.ashlr', 'authority');
    for (const path of [join(homedir(), '.ashlr'), parent, dir]) {
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: `${path} is not a plain directory` };
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        return { ok: false, reason: `${path} is not owned by this user` };
      }
    }
    if (process.platform !== 'win32') {
      chmodSync(parent, 0o700);
      chmodSync(dir, 0o700);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `fleet merge state directory unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));
}

function validate(raw: unknown, key: string): FleetMergeStateV1 | string {
  if (!isObject(raw)) return 'record is not an object';
  if (raw['v'] !== STATE_VERSION) return 'unknown record version';
  if (raw['key'] !== key) return 'record key does not match its file';
  if (raw['kind'] !== 'change' && raw['kind'] !== 'revert') return 'record kind is invalid';
  if (typeof raw['repo'] !== 'string' || !NAME_WITH_OWNER_RE.test(raw['repo'])) return 'record repo is not owner/name';
  if (typeof raw['repoPath'] !== 'string' || raw['repoPath'].length === 0) return 'record repoPath is missing';
  if (raw['proposalId'] !== null && typeof raw['proposalId'] !== 'string') return 'record proposalId is invalid';
  if (!isObject(raw['gates'])) return 'record gates are invalid';
  if (!isIsoOrNull(raw['createdAt']) || !isIsoOrNull(raw['updatedAt']) || !isIsoOrNull(raw['judgeWaitSince'])) {
    return 'record timestamps are invalid';
  }
  if (raw['pr'] !== null && !isObject(raw['pr'])) return 'record pr is invalid';
  if (isObject(raw['pr'])) {
    const pr = raw['pr'];
    if (!Number.isSafeInteger(pr['number']) || Number(pr['number']) < 1) return 'record PR number is invalid';
    if (typeof pr['headSha'] !== 'string' || !/^[0-9a-f]{40}$/.test(pr['headSha'])) return 'record PR head is invalid';
    if (typeof pr['baseSha'] !== 'string' || !/^[0-9a-f]{40}$/.test(pr['baseSha'])) return 'record PR base is invalid';
    if (typeof pr['ownerLane'] !== 'boolean' || typeof pr['ledgered'] !== 'boolean') return 'record PR flags are invalid';
  }
  if (raw['merge'] !== null && !isObject(raw['merge'])) return 'record merge attempt is invalid';
  if (raw['landing'] !== null && !isObject(raw['landing'])) return 'record landing is invalid';
  return raw as unknown as FleetMergeStateV1;
}

/** Read one record. `missing` is the only honest "no state"; anything unreadable is `corrupt`. */
export function readFleetMergeState(key: string): FleetMergeStateRead {
  if (!KEY_RE.test(key)) return { state: 'corrupt', reason: 'invalid state key' };
  const path = statePath(key);
  try {
    if (!existsSync(path)) return { state: 'missing' };
  } catch (error) {
    return { state: 'corrupt', reason: `state unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_STATE_BYTES,
    remainingBytes: MAX_STATE_BYTES,
  });
  if (!read.ok) return { state: 'corrupt', reason: `state read failed (${read.reason})` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { state: 'corrupt', reason: 'state is not JSON' };
  }
  const record = validate(parsed, key);
  return typeof record === 'string' ? { state: 'corrupt', reason: record } : { state: 'ok', record };
}

/** Atomically replace one record (0600, fsynced). Returns false on any failure. */
export function writeFleetMergeState(record: FleetMergeStateV1): boolean {
  if (!KEY_RE.test(record.key)) return false;
  const dir = ensureStateDir();
  if (!dir.ok) return false;
  try {
    const path = statePath(record.key);
    const text = `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() })}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return false;
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    writePrivateFileAtomically(tmp, path, text, { anchorPath: homedir(), label: 'fleet merge state' });
    return true;
  } catch {
    return false;
  }
}

/** A fresh record for a change (proposal) or a revert. */
export function newFleetMergeState(input: {
  key: string;
  kind: 'change' | 'revert';
  proposalId: string | null;
  revertsLandingId: string | null;
  repo: string;
  repoPath: string;
  enforcement: RepoEnforcement | null;
  nowIso: string;
}): FleetMergeStateV1 {
  return {
    v: STATE_VERSION,
    key: input.key,
    kind: input.kind,
    proposalId: input.proposalId,
    revertsLandingId: input.revertsLandingId,
    repo: input.repo,
    repoPath: input.repoPath,
    enforcement: input.enforcement,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    gates: {},
    judgeWaitSince: null,
    baseBranch: null,
    baseSha: null,
    treeSha: null,
    diffHash: null,
    verifyDigest: null,
    risk: null,
    files: null,
    linesAdded: null,
    linesDeleted: null,
    producer: null,
    judgeId: null,
    openGatesDigest: null,
    pr: null,
    merge: null,
    landing: null,
    landingLedgered: false,
    outcome: null,
    outcomeReason: null,
  };
}

/** Every record key currently stored (bounded). Unreadable directory ⇒ null (callers fail closed). */
export function listFleetMergeStateKeys(): string[] | null {
  const dir = fleetMergeStateDir();
  try {
    if (!existsSync(dir)) return [];
    const keys: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      if (KEY_RE.test(key)) keys.push(key);
      if (keys.length > MAX_STATES) return null;
    }
    return keys.sort();
  } catch {
    return null;
  }
}

/**
 * True when a fleet PR exists (or existed) for this proposal. The legacy
 * merge paths refuse such a proposal, so one change can never land twice —
 * once through the fleet App and once through the old handoff / local merge.
 * Unknown (corrupt) counts as true: refusing is the safe answer.
 */
export function proposalHasFleetPr(proposalId: string): boolean {
  const key = proposalStateKey(proposalId);
  if (!key) return false;
  const read = readFleetMergeState(key);
  if (read.state === 'missing') return false;
  if (read.state === 'corrupt') return true;
  return read.record.pr !== null;
}

/** Cross-process exclusive hold on one record while a pass works on it. */
export function lockFleetMergeState(key: string, waitMs = 0): LocalStoreLock | null {
  if (!KEY_RE.test(key)) return null;
  if (!ensureStateDir().ok) return null;
  return acquireLocalStoreLock(lockPath(key), waitMs, { anchorPath: homedir() });
}

export function unlockFleetMergeState(lock: LocalStoreLock | null): void {
  releaseLocalStoreLock(lock);
}

// ---------------------------------------------------------------------------
// Fleet PR merge class (V4): REFIX / DRAIN work generated from state, not text
// ---------------------------------------------------------------------------

/**
 * `gh pr view --json` fields the class derives from. Everything the decision
 * needs is structured GitHub state — never the PR title or body.
 */
export const FLEET_PR_GH_VIEW_FIELDS =
  'number,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup';

const GH_SHA_RE = /^[0-9a-f]{40}$/;

/** The four classes that generate work; the rest honestly say "wait" or "cannot tell". */
export type FleetPrClass =
  | 'green-ready'   // open, mergeable, up to date, gating checks green → DRAIN (land)
  | 'behind'        // open and clean, but the base moved → DRAIN (re-verify on the new base, then land)
  | 'conflicted'    // GitHub reports a merge conflict → REFIX (the produced change must be redone)
  | 'red-required'  // a gating check failed on the head → REFIX (new produced work must fix it)
  | 'pending'       // legitimately waiting: checks running, GitHub still computing, draft, or a moved head
  | 'closed'        // closed or merged — nothing to generate
  | 'unknown';      // unreadable / mismatched — fail closed, never invent work

/** The work family a class feeds: DRAIN lands or re-bases mergeable PRs; REFIX produces a fixed change. */
export const FLEET_PR_CLASS_WORK: Readonly<Record<FleetPrClass, 'drain' | 'refix' | 'none'>> = Object.freeze({
  'green-ready': 'drain',
  behind: 'drain',
  conflicted: 'refix',
  'red-required': 'refix',
  pending: 'none',
  closed: 'none',
  unknown: 'none',
});

export interface FleetPrClassification {
  class: FleetPrClass;
  /** `FLEET_PR_CLASS_WORK[class]` — denormalized so callers cannot drift from the map. */
  work: 'drain' | 'refix' | 'none';
  /** One machine-readable reason (`checks-green`, `base-moved`, …) — never PR text. */
  reason: string;
}

/** GitHub's view of a fleet PR — the validated subset of `gh pr view --json` the class reads. */
export interface FleetPrGhState {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** A fleet head is always same-repo; `true` means this view is not a fleet PR. */
  isCrossRepository: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** GitHub's single merge state: CLEAN, BEHIND, BLOCKED, DIRTY, DRAFT, HAS_HOOKS, UNSTABLE or UNKNOWN. */
  mergeStateStatus: string;
  /** G7's rollup of `statusCheckRollup` on this head. */
  checks: ChecksMemo['state'];
  /** `behind_by` from a `repos/{repo}/compare/{base}...{head}` read when the caller made one; null = not compared. */
  behindBy: number | null;
}

/**
 * The required-checks rollup of `gh pr view --json statusCheckRollup`, with
 * G7's conclusion semantics (merge-gates.ts): success / neutral / skipped are
 * green; failure / timed_out / action_required / startup_failure are red;
 * cancelled / stale / anything unfinished is pending (superseded, not proof);
 * an unreadable entry counts as pending — never green.
 */
export function rollupFleetPrChecks(rollup: unknown): ChecksMemo['state'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const entry of rollup) {
    if (!isObject(entry)) {
      pending = true;
      continue;
    }
    if (entry['__typename'] === 'StatusContext' || typeof entry['state'] === 'string') {
      const state = String(entry['state']).toUpperCase();
      if (state === 'FAILURE' || state === 'ERROR') return 'red';
      if (state !== 'SUCCESS') pending = true;
      continue;
    }
    const status = String(entry['status'] ?? '').toUpperCase();
    if (status !== 'COMPLETED') {
      pending = true;
      continue;
    }
    const conclusion = String(entry['conclusion'] ?? '').toUpperCase();
    if (['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'red';
    if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) pending = true;
  }
  return pending ? 'pending' : 'green';
}

/** Validate the raw `gh pr view --json` object; null when the PR itself is undescribed (→ class `unknown`). */
export function parseFleetPrGhState(raw: unknown): FleetPrGhState | null {
  if (!isObject(raw)) return null;
  const number = raw['number'];
  const state = raw['state'];
  const headSha = raw['headRefOid'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') return null;
  if (typeof headSha !== 'string' || !GH_SHA_RE.test(headSha)) return null;
  const mergeable = raw['mergeable'];
  const behindBy = raw['behind_by'] ?? raw['behindBy'];
  return {
    number: number as number,
    state,
    isDraft: raw['isDraft'] === true,
    headSha,
    headRef: typeof raw['headRefName'] === 'string' ? raw['headRefName'] : '',
    baseRef: typeof raw['baseRefName'] === 'string' ? raw['baseRefName'] : '',
    isCrossRepository: raw['isCrossRepository'] === true,
    mergeable: mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN',
    mergeStateStatus: typeof raw['mergeStateStatus'] === 'string' ? raw['mergeStateStatus'].toUpperCase() : 'UNKNOWN',
    checks: rollupFleetPrChecks(raw['statusCheckRollup']),
    behindBy: Number.isSafeInteger(behindBy) && (behindBy as number) >= 0 ? (behindBy as number) : null,
  };
}

function classified(cls: FleetPrClass, reason: string): FleetPrClassification {
  return { class: cls, work: FLEET_PR_CLASS_WORK[cls], reason };
}

/**
 * The merge class of a fleet PR from GitHub's structured state alone. Order is
 * load-bearing: conflicted outranks red-required (a conflicting head's check
 * results describe a tree that cannot apply), red-required outranks behind
 * (a refix on the new base fixes both; a rebase alone does not fix red
 * checks), and behind outranks pending (checks on a head that must move are
 * moot). Everything that cannot safely become work is `pending` / `closed` /
 * `unknown` — REFIX and DRAIN are generated only from the four real classes.
 *
 * `enforcement` decides whether a red check is a REQUIRED check: under
 * `server` only a `BLOCKED` merge state proves one failed (UNSTABLE is a
 * non-required status failing and does not gate the merge); under `local` —
 * or enforcement we do not know — every check that ran gates the merge, the
 * same reading G7 makes.
 */
export function classifyFleetPrGh(
  gh: FleetPrGhState | null,
  opts?: { enforcement?: RepoEnforcement | null },
): FleetPrClassification {
  if (gh === null) return classified('unknown', 'github-view-unreadable');
  if (gh.isCrossRepository) return classified('unknown', 'cross-repository');
  if (gh.state !== 'OPEN') return classified('closed', gh.state === 'MERGED' ? 'pr-merged' : 'pr-closed');
  if (gh.isDraft) return classified('pending', 'draft');
  if (gh.mergeable === 'CONFLICTING' || gh.mergeStateStatus === 'DIRTY') return classified('conflicted', 'merge-conflict');
  const redIsRequired = opts?.enforcement !== 'server' || gh.mergeStateStatus === 'BLOCKED';
  if (gh.checks === 'red' && redIsRequired) return classified('red-required', 'required-check-failed');
  if (gh.mergeStateStatus === 'BEHIND' || (gh.behindBy ?? 0) > 0) return classified('behind', 'base-moved');
  if (gh.mergeable !== 'MERGEABLE' || gh.mergeStateStatus === 'UNKNOWN') return classified('pending', 'github-computing');
  const requiredGreen = gh.checks === 'green' || (gh.checks === 'red' && !redIsRequired);
  if (!requiredGreen) return classified('pending', gh.checks === 'none' ? 'checks-none' : 'checks-pending');
  if (gh.mergeStateStatus === 'BLOCKED' || gh.mergeStateStatus === 'DRAFT') return classified('pending', 'blocked-non-check');
  if (gh.mergeStateStatus === 'CLEAN' || gh.mergeStateStatus === 'HAS_HOOKS' || gh.mergeStateStatus === 'UNSTABLE') {
    return classified('green-ready', 'checks-green');
  }
  return classified('pending', 'unrecognised-state');
}

/**
 * The class of the fleet PR a merge-state record tracks. The record anchors
 * identity: a corrupt record or a PR identity that does not match fails
 * closed (`unknown`); a record that already reached a terminal state stays
 * `closed` even when a stale read says open (the standing pass re-reads
 * GitHub every tick and repairs the record); a head that moved since the
 * fleet verified it is `pending` — the new head is not verified work yet.
 * With no record (`missing`) the gh view alone classifies, at the strict
 * every-check-gates reading.
 */
export function classifyFleetMergeStatePr(read: FleetMergeStateRead, gh: FleetPrGhState | null): FleetPrClassification {
  if (read.state === 'corrupt') return classified('unknown', 'merge-state-corrupt');
  if (read.state === 'missing') return classifyFleetPrGh(gh, {});
  const pr = read.record.pr;
  if (pr === null) return classified('unknown', 'no-fleet-pr');
  if (pr.state !== 'open' || read.record.outcome !== null) return classified('closed', 'record-terminal');
  if (gh === null) return classified('unknown', 'github-view-unreadable');
  if (gh.number !== pr.number) return classified('unknown', 'pr-mismatch');
  if (gh.headSha !== pr.headSha || gh.headRef !== pr.branch || gh.baseRef !== pr.baseBranch) {
    return classified('pending', 'head-moved');
  }
  return classifyFleetPrGh(gh, { enforcement: read.record.enforcement });
}
