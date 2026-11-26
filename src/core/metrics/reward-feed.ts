/**
 * reward-feed.ts — the fleet producer for the reward-signal substrate.
 *
 * `reward-signals.jsonl` is the shared per-job reward ledger read by router
 * calibration, the eval harness and the dashboard, but nothing in the
 * repository ever wrote to it: `writeRewardSignal` had no caller, so every
 * consumer saw an empty substrate. This module closes that gap. On resident
 * daemon ticks (the `reward-sync` off-tick job, gated on
 * `foundry.selfImprove`) it folds the tail of the fleet jobs ledger
 * (`<runs>/metrics/jobs.jsonl`) plus api-spend costs into `RewardSignalInput`
 * rows and appends them with `writeRewardSignals`.
 *
 * THE RULES, and why:
 *   - RESOLVED MERGE EVIDENCE ONLY. A row is emitted only for a job whose PR
 *     lifecycle reached an authoritative resolution: MERGED (a terminal phase
 *     across phase|state|outcome|status|result|conclusion, a 'merged' event
 *     name when no phase field resolves, or merged:true) or CLOSED-unmerged
 *     (the same dialect for 'closed'/CLOSED or merged:false).
 *     Task-level rows — launch, finish, DONE-NOOP, OPEN, task_outcome —
 *     never count: a job that failed before publishing has unknown merge
 *     state, not a proven non-merge, and stays unwritten.
 *   - REVERTS ARE NOT HELD MERGES. Positive revert evidence (the slot-yield
 *     vocabulary: reverted:true, reverted_at/revertedAt, revert event/state
 *     names) at or after the latest effective merge resolves the job as merged:false —
 *     the v1 schema has no revert dimension and consumers score held merges.
 *     A revert that names a PR can only discount that PR's merge.
 *     A later merge is a fresh held merge. For a known merge, its merge time
 *     bounds dispatch and CI evidence even when a revert changes the verdict.
 *     Reverts only git history or the
 *     outcome/cloud ledgers prove — the standing `owner/repo#n` keys
 *     `revertedPrKeys()` resolves — discount the same way when the held
 *     merge's PR URL is claimed by exactly that job (the unambiguous-claim
 *     join skill-nudge and outcome-learning apply); a contested or foreign
 *     claim never resolves, and absent keys change nothing.
 *   - dispatchedAt IS THE LAST DISPATCH BEFORE THE OUTCOME. claim,
 *     batch_claim and launch rows are dispatch evidence; the latest at or
 *     before the outcome produced it. Without an eligible dispatch row
 *     in the window, or with an undated dispatch that could supersede it,
 *     the dispatch time is unknown: skip.
 *   - ciWallMs IS THE LEDGER'S CI BOUNDARIES. jobs.jsonl's optional
 *     ci_start/ci_complete event dialect — the same boundaries
 *     queue/visit-sync and fleet/job-latency pair — supplies the reward
 *     row's CI wall time when a job carries exactly one of each and the
 *     complete stamp does not precede the start. Ambiguous or missing
 *     boundaries leave ciWallMs unset: unknown stays unknown, never a
 *     partial guess and never another phase's duration.
 *   - FIRST WRITE WINS. JobIds already in the reward ledger are never
 *     reconsidered, so a sliding tail cannot rewrite history; the batch
 *     writer still fails closed on any conflicting outcome.
 *   - BOUNDED AND BEST-EFFORT. Both tails use the router-outcome 16 MiB
 *     bound; syncRewardSignalsFromJobsLedger never throws — callers get a
 *     result object with per-source health.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ashlrHome } from '../cloud/store.js';
import { isNodePoolLedgerRow } from '../fleet/jobs-ledger-dialect.js';
import { hasRevertEvidence } from '../fleet/slot-yield.js';
import type { UsageReading } from '../fabric/usage-signal-writer.js';
import {
  foldSpendCosts, readLedgerTail,
  ROUTER_OUTCOME_LEDGER_RELATIVE, ROUTER_SPEND_LEDGER_RELATIVE,
  type LedgerReadState, type LedgerTailRead,
} from '../router/outcomes.js';
import { parseLedgerTs } from './loop.js';
import {
  latestRewardSignals, rewardSignalPath, writeRewardSignals, type RewardSignalInput,
} from './reward-signal.js';

const JOB_ID_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const STATE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const;
// Terminal timestamps belong to the matching verdict. Generic receipt timestamps
// can date any row and independently bound when a verdict becomes observable.
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'recordedAt', 'updatedAt'] as const;
const MERGED_AT_KEYS = ['mergedAt', 'merged_at'] as const;
const CLOSED_AT_KEYS = ['closedAt', 'closed_at'] as const;
const REVERTED_AT_KEYS = ['revertedAt', 'reverted_at'] as const;
const LANE_KEYS = ['lane', 'pool', 'arm'] as const;
const URL_KEYS = ['url', 'pr_url', 'prUrl', 'pr', 'html_url'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;

/** Same id alphabet the reward writer accepts (JOB_ID in reward-signal.ts). */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const POOL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/** Batch session wrappers carry aggregate telemetry. Members have their own job ids. */
const BATCH_SESSION_PREFIX = 'RQ-BATCH-';
/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;

/** Rows that record a dispatch (the launch that produced later outcomes). */
const DISPATCH_EVENTS: ReadonlySet<string> = new Set(['claim', 'batch_claim', 'launch']);
const MERGE_STATES: ReadonlySet<string> = new Set(['MERGED']);
const CLOSED_STATES: ReadonlySet<string> = new Set(['CLOSED']);

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** The first observed lane in the dispatch receipt's alias order. */
function dispatchLane(row: Record<string, unknown>): string | null {
  for (const key of LANE_KEYS) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const lane = value.trim();
    if (lane.toLowerCase() !== 'unknown' && POOL_PATTERN.test(lane)) return lane;
  }
  return null;
}

const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * Prefer a terminal verdict across the phase aliases. With no terminal
 * phase, an observed nonterminal phase still blocks the event fallback.
 */
function outcomeStateOf(row: Record<string, unknown>): string {
  let observedPhase = false;
  for (const key of STATE_KEYS) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const state = value.trim().toUpperCase();
    if (MERGE_STATES.has(state) || CLOSED_STATES.has(state)) return state;
    if (state !== '' && state !== 'UNKNOWN') observedPhase = true;
  }
  return observedPhase ? '' : firstString(row, EVENT_KEYS)?.toUpperCase() ?? '';
}

/** The first parseable ISO or epoch-millisecond stamp among the given aliases. */
function timestampOf(row: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && value > 0 && value <= MAX_EPOCH_MS) return value;
    const parsed = parseLedgerTs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** A unique PR repository takes precedence over the receipt's repo label. */
function repoOf(row: Record<string, unknown>, prKeys: readonly string[]): string | null | undefined {
  const repos = new Set(prKeys.map((key) => key.slice(0, key.lastIndexOf('#')))
    .filter((repo) => REPO_PATTERN.test(repo)));
  if (repos.size > 1) return null;
  if (repos.size === 1) return [...repos][0];
  const repo = firstString(row, ['repo']);
  return repo !== null && REPO_PATTERN.test(repo) ? repo.toLowerCase() : undefined;
}

/** `owner/repo#n` (lowercase repo) for a pull URL; null when the URL is not that shape. */
function pullRequestKey(url: string): string | null {
  const match = GITHUB_PULL_URL.exec(url);
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}` : null;
}

/**
 * The standing revert-set join: a held merge whose verdict row's pull URL is
 * claimed by exactly that job and whose `owner/repo#n` key stands in the
 * supplied set counts as reverted — git-history and outcome-ledger reverts
 * the jobs ledger never spelled still discount the reward. Absent, empty or
 * unmatched keys change nothing, and a contested or foreign claim never
 * resolves — the same rule skill-nudge and outcome-learning apply.
 */
function standingReverted(
  id: string,
  key: string | null,
  claims: ReadonlyMap<string, ReadonlySet<string>> | null,
  keys: ReadonlySet<string> | null | undefined,
): boolean {
  if (claims === null || keys === null || keys === undefined || key === null || !keys.has(key)) return false;
  const claimants = claims.get(key);
  return claimants?.size === 1 && claimants.has(id);
}

interface DispatchMark { ms: number; lane: string | null; repo: string | null }

interface ResolutionMark {
  atMs: number;
  resolvedMs: number;
  /** null means conflicting evidence, undefined means no repository was observed. */
  repo: string | null | undefined;
  prKeys: string[];
}

function receiptPrKeys(row: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const field of URL_KEYS) {
    const value = row[field];
    const key = typeof value === 'string' ? pullRequestKey(value.trim()) : null;
    if (key !== null) keys.add(key);
  }
  return [...keys];
}

function latestResolution(current: ResolutionMark | null, next: ResolutionMark): ResolutionMark {
  if (current === null || next.resolvedMs > current.resolvedMs) return next;
  if (next.resolvedMs < current.resolvedMs) return current;
  if (next.atMs > current.atMs) return next;
  if (next.atMs < current.atMs) return current;

  // Tied receipts cannot establish which PR supplied the verdict.
  const repo = current.repo === undefined ? next.repo
    : next.repo === undefined || current.repo === next.repo ? current.repo : null;
  return { ...current, repo, prKeys: [...new Set([...current.prKeys, ...next.prKeys])] };
}

interface RewardJobAccum {
  dispatches: DispatchMark[];
  dispatchUndated: boolean;
  batchClaims: Set<number>;
  /** Latest merge-resolution row: row time, the GitHub mergedAt it reported, and its PR keys. */
  merge: ResolutionMark | null;
  /** Latest closed-unmerged resolution time, falling back to the row stamp. */
  close: ResolutionMark | null;
  /** Latest effective revert per PR, with null for receipts lacking PR identity. */
  reverts: Map<string | null, number>;
  /** True when the standing revert set proves the held merge's PR was reverted. */
  standingReverted: boolean;
  /** ci_start/ci_complete boundary stamps, deduped like job-latency's boundary lists. */
  ciBoundaryUndated: boolean;
  ciStarts: Map<number, Set<string>>;
  ciCompletions: Map<number, Set<string>>;
}

function newAccum(): RewardJobAccum {
  return {
    dispatches: [],
    dispatchUndated: false, batchClaims: new Set(),
    merge: null, close: null, reverts: new Map(), standingReverted: false,
    ciBoundaryUndated: false, ciStarts: new Map(), ciCompletions: new Map(),
  };
}

/** Replayed boundaries share a timestamp but can carry conflicting PR claims. */
function noteCiBoundary(
  acc: RewardJobAccum, kind: 'start' | 'complete', at: number, prKeys: readonly string[],
): void {
  const boundaries = kind === 'start' ? acc.ciStarts : acc.ciCompletions;
  const keys = boundaries.get(at) ?? new Set<string>();
  for (const key of prKeys) keys.add(key);
  boundaries.set(at, keys);
}

/**
 * CI wall time requires one unambiguous pair inside the rewarded execution's
 * dispatch-to-outcome window. Reused job ids can carry CI from earlier runs.
 */
function ciWallEvidence(
  acc: RewardJobAccum, dispatchMs: number, outcomeMs: number, outcomePrKeys: readonly string[],
): { ciWallMs?: number } {
  if (acc.ciBoundaryUndated) return {};
  const inWindow = (at: number): boolean => at >= dispatchMs && at <= outcomeMs;
  const starts = [...acc.ciStarts.keys()].filter(inWindow);
  const completions = [...acc.ciCompletions.keys()].filter(inWindow);
  if (starts.length !== 1 || completions.length !== 1) return {};
  const start = starts[0]!;
  const complete = completions[0]!;
  if (complete < start) return {};
  for (const claim of acc.batchClaims) {
    if (claim >= start && claim <= complete) return {};
  }
  const keys = new Set([
    ...outcomePrKeys, ...acc.ciStarts.get(start)!, ...acc.ciCompletions.get(complete)!,
  ]);
  if (keys.size > 1) return {};
  return { ciWallMs: complete - start };
}

/**
 * Fold jobs.jsonl text into one RewardSignalInput per job with resolved merge
 * evidence. Pure; never throws. Undated dispatch and CI receipts with a
 * usable job id are retained as ambiguity. Both a verdict receipt and its
 * effective resolution must fall at or before `nowMs` to contribute a verdict.
 *
 * `revertedPrKeys` is the caller-resolved standing revert set (`owner/repo#n`
 * keys from the outcome ledger, cloud tasks and the revert-outcomes scan —
 * the same set skill-nudge consumes). When supplied, a held merge whose PR
 * URL is claimed by exactly that job and whose key stands in the set folds
 * as merged:false; absent, empty or unmatched keys change nothing.
 */
export function foldJobsLedgerRewards(
  text: string, nowMs: number, costs?: ReadonlyMap<string, number>,
  revertedPrKeys?: ReadonlySet<string> | null,
): RewardSignalInput[] {
  const jobs = new Map<string, RewardJobAccum>();
  // Canonical PR key -> claiming job ids, collected only when the caller supplied
  // standing revert keys — the same unambiguous-claim evidence pass
  // skill-nudge and outcome-learning run, so a contested or foreign URL
  // never resolves. Node-pool producer rows are a different dialect and
  // batch session ids are infrastructure: neither ever claims.
  const claims = revertedPrKeys === undefined || revertedPrKeys === null || revertedPrKeys.size === 0
    ? null : new Map<string, Set<string>>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    if (row['launched'] === false) continue;
    const id = firstString(row, JOB_ID_KEYS);
    if (id === null || id.startsWith(BATCH_SESSION_PREFIX) || isNodePoolLedgerRow(row)) continue;
    const state = outcomeStateOf(row);
    const isMerge = row['merged'] === true || MERGE_STATES.has(state);
    const isClose = !isMerge && (row['merged'] === false || CLOSED_STATES.has(state));
    const resolvedAt = isMerge ? timestampOf(row, MERGED_AT_KEYS)
      : isClose ? timestampOf(row, CLOSED_AT_KEYS) : null;
    const at = timestampOf(row, TS_KEYS) ?? resolvedAt;
    const explicitRevertMs = timestampOf(row, REVERTED_AT_KEYS);
    const receiptAt = at ?? explicitRevertMs;
    if (receiptAt !== null && receiptAt > nowMs) continue;
    // A future verdict cannot establish PR ownership or supply other evidence yet.
    if (resolvedAt !== null && resolvedAt > nowMs) continue;
    const prKeys = receiptPrKeys(row);
    if (claims !== null) {
      for (const key of prKeys) {
        const set = claims.get(key) ?? new Set<string>();
        set.add(id);
        claims.set(key, set);
      }
    }
    if (!JOB_ID_PATTERN.test(id)) continue;
    const name = firstString(row, EVENT_KEYS)?.toLowerCase();
    const dispatch = name !== undefined && DISPATCH_EVENTS.has(name);
    const ciBoundary = name === 'ci_start' || name === 'ci_complete';
    if (receiptAt === null && !dispatch && !ciBoundary) continue;
    let acc = jobs.get(id);
    if (!acc) {
      acc = newAccum();
      jobs.set(id, acc);
    }
    if (at === null) {
      if (dispatch) acc.dispatchUndated = true;
      if (ciBoundary) acc.ciBoundaryUndated = true;
    } else if (dispatch) {
      acc.dispatches.push({ ms: at, lane: dispatchLane(row), repo: repoOf(row, prKeys) ?? null });
      if (name === 'batch_claim') acc.batchClaims.add(at);
    } else if (ciBoundary) {
      noteCiBoundary(acc, name === 'ci_start' ? 'start' : 'complete', at, prKeys);
    }
    const revertedAtMs = explicitRevertMs ?? (hasRevertEvidence(row) ? at : null);
    if (revertedAtMs !== null && revertedAtMs <= nowMs) {
      // Only a receipt without a PR reference can apply job-wide.
      const key = prKeys.length === 1 ? prKeys[0]! : null;
      if (key !== null || firstString(row, URL_KEYS) === null) {
        acc.reverts.set(key, Math.max(acc.reverts.get(key) ?? 0, revertedAtMs));
      }
    }
    if (at === null) continue;
    if (isMerge) {
      acc.merge = latestResolution(acc.merge, {
        atMs: at, resolvedMs: resolvedAt ?? at, repo: repoOf(row, prKeys), prKeys,
      });
    } else if (isClose) {
      acc.close = latestResolution(acc.close, {
        atMs: at, resolvedMs: resolvedAt ?? at, repo: repoOf(row, prKeys), prKeys,
      });
    }
  }
  for (const [id, acc] of jobs) {
    const keys = acc.merge?.prKeys;
    const key = keys?.length === 1 ? keys[0]! : null;
    acc.standingReverted = standingReverted(id, key, claims, revertedPrKeys);
  }
  const inputs: RewardSignalInput[] = [];
  for (const [id, acc] of jobs) {
    const input = rewardInput(id, acc, costs?.get(id));
    if (input !== null) inputs.push(input);
  }
  return inputs.sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
}

/** Latest dispatch at or before the outcome, regardless of ledger row order. */
function dispatchBefore(acc: RewardJobAccum, boundMs: number): DispatchMark | null {
  if (acc.dispatchUndated) return null;
  let latestMs: number | null = null;
  const lanes = new Set<string>();
  const repos = new Set<string>();
  for (const dispatch of acc.dispatches) {
    if (dispatch.ms > boundMs || (latestMs !== null && dispatch.ms < latestMs)) continue;
    if (dispatch.ms !== latestMs) {
      latestMs = dispatch.ms;
      lanes.clear();
      repos.clear();
    }
    if (dispatch.lane !== null) lanes.add(dispatch.lane);
    if (dispatch.repo !== null) repos.add(dispatch.repo);
  }
  // The dispatcher stamps receipts to the second. Conflicting lanes at the
  // same timestamp cannot prove which pool earned the reward.
  return latestMs === null ? null : {
    ms: latestMs,
    lane: lanes.size === 1 ? [...lanes][0]! : null,
    repo: repos.size === 1 ? [...repos][0]! : null,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * One job's reward input, or null when the evidence cannot support a row:
 * no dispatch in the window, a dispatch after the outcome, a merge whose
 * GitHub timestamp predates every observed dispatch, or no resolved verdict.
 */
function rewardInput(
  id: string, acc: RewardJobAccum, costUsd: number | undefined,
): RewardSignalInput | null {
  const cost = costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;
  if (acc.merge !== null) {
    const merge = acc.merge;
    const key = merge.prKeys.length === 1 ? merge.prKeys[0]! : null;
    const revertedAt = Math.max(acc.reverts.get(null) ?? -Infinity, acc.reverts.get(key) ?? -Infinity);
    const heldMerge = !acc.standingReverted && merge.resolvedMs > revertedAt;
    const dispatch = dispatchBefore(acc, merge.resolvedMs);
    if (dispatch === null) return null;
    return {
      jobId: id, pool: dispatch.lane,
      repo: merge.repo === undefined ? dispatch.repo : merge.repo,
      merged: heldMerge, dispatchedAt: iso(dispatch.ms), mergedAt: heldMerge ? iso(merge.resolvedMs) : null,
      costUsd: cost,
      ...ciWallEvidence(acc, dispatch.ms, merge.resolvedMs, merge.prKeys),
    };
  }
  // A revert can resolve a job on its own, but it cannot extend the
  // execution window of an explicitly closed PR.
  let resolutionMs = acc.close?.resolvedMs ?? 0;
  if (acc.close === null) {
    for (const revertedAt of acc.reverts.values()) resolutionMs = Math.max(resolutionMs, revertedAt);
  }
  if (resolutionMs > 0) {
    const dispatch = dispatchBefore(acc, resolutionMs);
    if (dispatch === null) return null;
    return {
      jobId: id, pool: dispatch.lane,
      repo: acc.close?.repo === undefined ? dispatch.repo : acc.close.repo,
      merged: false, dispatchedAt: iso(dispatch.ms), mergedAt: null,
      costUsd: cost,
      ...ciWallEvidence(acc, dispatch.ms, resolutionMs, acc.close?.prKeys ?? []),
    };
  }
  return null;
}

export interface RewardFeedOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as router outcomes). */
  runsDir?: string;
  /** Reward-ledger home; defaults to ashlrHome(). */
  home?: string;
  /** Injected jobs-ledger tail text; skips the jobs.jsonl read when set. */
  jobsText?: string;
  /** Injected api-spend tail text; skips that read when set. */
  spendText?: string;
  /**
   * Standing revert keys (`owner/repo#n`) the caller resolved from the
   * outcome ledger, cloud tasks and the revert-outcomes scan ledger — the
   * same set skill-nudge consumes. A held merge whose verdict row's pull
   * URL is claimed by exactly that job and whose key stands in the set
   * folds as merged:false; absent or unmatched keys change nothing.
   */
  revertedPrKeys?: ReadonlySet<string> | null;
  /** Usage journal for pool-cost metering; default probes the known locations. */
  usageLogPath?: string;
  usageReadings?: readonly UsageReading[];
  now?: () => Date;
  signal?: AbortSignal;
}

export interface RewardFeedResult {
  /** Health of the jobs-ledger tail; only 'read' can produce rows. */
  state: LedgerReadState | 'error';
  jobsPath: string;
  /** True when the jobs tail dropped older bytes — some dispatches may be out of window. */
  truncated: boolean;
  /** Health of the api-spend tail behind costUsd joins. */
  spendState: LedgerReadState | 'not-read';
  /** Jobs with resolved merge evidence that produced a reward input. */
  folded: number;
  /** Folded jobIds already present in the reward ledger — never reconsidered. */
  skippedRecorded: number;
  recorded: number;
  duplicates: number;
  /** jobIds the batch writer refused: conflicting outcomes or invalid rows. */
  conflicts: number;
  invalid: number;
  /** Reward ledger path written to. */
  path: string;
}

function emptyResult(state: RewardFeedResult['state'], jobsPath: string, path: string): RewardFeedResult {
  return {
    state, jobsPath, truncated: false, spendState: 'not-read',
    folded: 0, skippedRecorded: 0, recorded: 0, duplicates: 0, conflicts: 0, invalid: 0, path,
  };
}

/** First existing usage journal among the known locations, when one is readable. */
function probeUsageLog(runsDir: string, home: string): string | undefined {
  for (const candidate of [join(runsDir, 'queue', 'usage-readings.log'), join(home, 'usage-readings.log')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function tailOrInjected(
  injected: string | undefined, path: string,
): Promise<LedgerTailRead> {
  if (injected !== undefined) return { state: 'read', text: injected, truncated: false };
  return readLedgerTail(path);
}

/**
 * Refresh the reward-signal ledger from the fleet jobs ledger. Runs inside
 * the daemon's reward-sync off-tick job; safe to call any time. Never throws:
 * ledger problems come back as `state`, write problems as `state: 'error'`
 * with the counts reached so far.
 */
export async function syncRewardSignalsFromJobsLedger(
  opts: RewardFeedOptions = {},
): Promise<RewardFeedResult> {
  const nowDate = (opts.now ?? (() => new Date()))();
  const nowMs = nowDate.getTime();
  const home = opts.home ?? ashlrHome();
  const path = rewardSignalPath(home);
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const jobsPath = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  try {
    const jobs = await tailOrInjected(opts.jobsText, jobsPath);
    if (jobs.state !== 'read') return emptyResult(jobs.state, jobsPath, path);
    if (opts.signal?.aborted) {
      return { ...emptyResult('read', jobsPath, path), truncated: jobs.truncated };
    }

    const spend = await tailOrInjected(opts.spendText, join(runsDir, ROUTER_SPEND_LEDGER_RELATIVE));
    const spendState: RewardFeedResult['spendState'] = spend.state === 'read' ? 'read' : spend.state;
    // Reward rows are first-write-wins and carry no coverage flag for USD.
    const costs = spend.state === 'read' && !spend.truncated ? foldSpendCosts(spend.text) : undefined;

    const folded = foldJobsLedgerRewards(jobs.text, nowMs, costs, opts.revertedPrKeys);
    const recorded = new Set(latestRewardSignals(path).map((row) => row.jobId));
    const pending = folded.filter((input) => {
      if (recorded.has(input.jobId)) return false;
      recorded.add(input.jobId);
      return true;
    });
    const result: RewardFeedResult = {
      ...emptyResult('read', jobsPath, path),
      truncated: jobs.truncated, spendState,
      folded: folded.length, skippedRecorded: folded.length - pending.length,
    };
    if (opts.signal?.aborted || pending.length === 0) return result;

    const out = writeRewardSignals(pending, {
      path,
      ...(opts.usageReadings !== undefined
        ? { usageReadings: opts.usageReadings }
        : { usageLogPath: opts.usageLogPath ?? probeUsageLog(runsDir, home) }),
      now: () => nowDate,
    });
    result.recorded = out.recorded.length;
    result.duplicates = out.duplicates.length;
    result.conflicts = out.conflicts.length;
    result.invalid = out.invalid.length;
    return result;
  } catch {
    return emptyResult('error', jobsPath, path);
  }
}
