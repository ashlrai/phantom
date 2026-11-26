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
 *     names) newer than the latest merge resolves the job as merged:false —
 *     the v1 schema has no revert dimension and consumers score held merges.
 *     A later merge is a fresh held merge. Reverts only git history or the
 *     outcome/cloud ledgers prove — the standing `owner/repo#n` keys
 *     `revertedPrKeys()` resolves — discount the same way when the held
 *     merge's PR URL is claimed by exactly that job (the unambiguous-claim
 *     join skill-nudge and outcome-learning apply); a contested or foreign
 *     claim never resolves, and absent keys change nothing.
 *   - dispatchedAt IS THE LAST DISPATCH BEFORE THE OUTCOME. claim,
 *     batch_claim and launch rows are dispatch evidence; the latest at or
 *     before the outcome produced it. Without an eligible dispatch row
 *     in the window the dispatch time is unknown: skip.
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
/**
 * jobs.jsonl timestamp dialect: ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt — the same field set and order dispatchd `_vc_pick`
 * and metrics/loop accept. `at` stays the row's own stamp; the GitHub merge
 * time is read separately through MERGED_AT_KEYS.
 */
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const MERGED_AT_KEYS = ['mergedAt', 'merged_at', 'closedAt', 'closed_at'] as const;
const LANE_KEYS = ['lane', 'pool', 'arm'] as const;
const URL_KEYS = ['url', 'pr_url', 'prUrl', 'pr'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;

/** Same id alphabet the reward writer accepts (JOB_ID in reward-signal.ts). */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+\/?$/;
const POOL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/** Batch session ids are infrastructure and never claim a PR — the rule the sibling outcome folds apply. */
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

/** jobs.jsonl stamps arrive as ISO (with or without offset colon) or epoch-ms numbers. */
function ledgerTs(row: Record<string, unknown>): number | null {
  for (const key of TS_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const parsed = parseLedgerTs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function stateOf(row: Record<string, unknown>): string {
  return (firstString(row, STATE_KEYS) ?? '').toUpperCase();
}

/**
 * Event names that carry a terminal merge verdict when no phase field
 * resolves — the 'merged'/'closed' convention job-outcomes, the router
 * outcome fold and the fleet yield readers share. A resolved phase stays
 * authoritative over the event name; every other spelling stays unknown.
 */
const OUTCOME_EVENT_STATES: Readonly<Record<string, string>> = { merged: 'MERGED', closed: 'CLOSED' };

/** Terminal phase across the state dialect, or the event-name verdict when no phase field resolves. */
function outcomeStateOf(row: Record<string, unknown>): string {
  const state = stateOf(row);
  if (state !== '') return state;
  const event = firstString(row, EVENT_KEYS);
  return event === null ? '' : OUTCOME_EVENT_STATES[event.toLowerCase()] ?? '';
}

/** The GitHub merge timestamp a MERGED row carries, when it has one. */
function mergedAtValue(row: Record<string, unknown>): number | null {
  for (const key of MERGED_AT_KEYS) {
    const parsed = parseLedgerTs(row[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** owner/repo from the row's repo field, or proven by its GitHub PR URL. */
function repoOf(row: Record<string, unknown>): string | null {
  const repo = firstString(row, ['repo']);
  if (repo && REPO_PATTERN.test(repo)) return repo;
  const url = firstString(row, URL_KEYS);
  const match = url ? PR_URL_PATTERN.exec(url.replace(/\/+$/, '')) : null;
  if (!match) return null;
  const derived = `${match[1]}/${match[2]}`;
  return REPO_PATTERN.test(derived) ? derived : null;
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
  mergeUrl: string | null,
  claims: ReadonlyMap<string, ReadonlySet<string>> | null,
  keys: ReadonlySet<string> | null | undefined,
): boolean {
  if (claims === null || keys === null || keys === undefined || mergeUrl === null) return false;
  const claimants = claims.get(mergeUrl);
  if (claimants === undefined || claimants.size !== 1 || !claimants.has(id)) return false;
  const key = pullRequestKey(mergeUrl);
  return key !== null && keys.has(key);
}

interface DispatchMark { ms: number; lane: string | null }

interface RewardJobAccum {
  repo: string | null;
  dispatches: DispatchMark[];
  /** Latest merge-resolution row: row time, the GitHub mergedAt it reported, and its PR URL. */
  merge: { atMs: number; mergedAtMs: number; url: string | null } | null;
  /** Latest closed-unmerged resolution row time. */
  closedMs: number | null;
  /** Latest positive revert-evidence row time. */
  revertMs: number | null;
  /** True when the standing revert set proves the held merge's PR was reverted. */
  standingReverted: boolean;
  /** ci_start/ci_complete boundary stamps, deduped like job-latency's boundary lists. */
  ciStartAts: number[];
  ciCompleteAts: number[];
}

function newAccum(): RewardJobAccum {
  return {
    repo: null, dispatches: [],
    merge: null, closedMs: null, revertMs: null, standingReverted: false,
    ciStartAts: [], ciCompleteAts: [],
  };
}

/** One CI boundary stamp per distinct row time — a repeated append cannot fake ambiguity. */
function noteCiBoundary(acc: RewardJobAccum, kind: 'start' | 'complete', at: number): void {
  const list = kind === 'start' ? acc.ciStartAts : acc.ciCompleteAts;
  if (!list.includes(at)) list.push(at);
}

/**
 * CI wall time requires one unambiguous pair inside the rewarded execution's
 * dispatch-to-outcome window. Reused job ids can carry CI from earlier runs.
 */
function ciWallEvidence(acc: RewardJobAccum, dispatchMs: number, outcomeMs: number): { ciWallMs?: number } {
  if (acc.ciStartAts.length !== 1 || acc.ciCompleteAts.length !== 1) return {};
  const start = acc.ciStartAts[0]!;
  const complete = acc.ciCompleteAts[0]!;
  if (start < dispatchMs || complete > outcomeMs || complete < start) return {};
  return { ciWallMs: complete - start };
}

/**
 * Fold jobs.jsonl text into one RewardSignalInput per job with resolved merge
 * evidence. Pure; never throws; rows without a usable timestamp or job id are
 * ignored, and rows stamped after `nowMs` cannot fabricate outcomes.
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
  // PR URL -> claiming job ids, collected only when the caller supplied
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
    const id = firstString(row, JOB_ID_KEYS);
    if (claims !== null && id !== null && !id.startsWith(BATCH_SESSION_PREFIX) && !isNodePoolLedgerRow(row)) {
      const url = firstString(row, URL_KEYS);
      if (url !== null) {
        const set = claims.get(url) ?? new Set<string>();
        set.add(id);
        claims.set(url, set);
      }
    }
    if (!id || !JOB_ID_PATTERN.test(id)) continue;
    const at = ledgerTs(row);
    if (at === null || at > nowMs) continue;
    let acc = jobs.get(id);
    if (!acc) {
      acc = newAccum();
      jobs.set(id, acc);
    }
    acc.repo ??= repoOf(row);
    const event = firstString(row, EVENT_KEYS);
    if (event !== null) {
      const name = event.toLowerCase();
      if (DISPATCH_EVENTS.has(name)) {
        acc.dispatches.push({ ms: at, lane: firstString(row, LANE_KEYS) });
      } else if (name === 'ci_start' || name === 'ci_complete') {
        noteCiBoundary(acc, name === 'ci_start' ? 'start' : 'complete', at);
      }
    }
    if (hasRevertEvidence(row)) acc.revertMs = Math.max(acc.revertMs ?? 0, at);
    const state = outcomeStateOf(row);
    if (row['merged'] === true || MERGE_STATES.has(state)) {
      const mergedAtMs = mergedAtValue(row) ?? at;
      if (acc.merge === null || at >= acc.merge.atMs) {
        acc.merge = { atMs: at, mergedAtMs, url: firstString(row, URL_KEYS) };
      }
    } else if (row['merged'] === false || CLOSED_STATES.has(state)) {
      acc.closedMs = Math.max(acc.closedMs ?? 0, at);
    }
  }
  for (const [id, acc] of jobs) {
    acc.standingReverted = standingReverted(id, acc.merge?.url ?? null, claims, revertedPrKeys);
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
  let latest: DispatchMark | null = null;
  for (const dispatch of acc.dispatches) {
    if (dispatch.ms <= boundMs && (latest === null || dispatch.ms > latest.ms)) {
      latest = dispatch;
    }
  }
  return latest;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * One job's reward input, or null when the evidence cannot support a row:
 * no dispatch in the window, a dispatch after the outcome, a merge whose
 * GitHub timestamp predates dispatch, or a merge superseded by a revert —
 * row-level revert evidence or the standing revert set's unambiguous claim.
 */
function rewardInput(
  id: string, acc: RewardJobAccum, costUsd: number | undefined,
): RewardSignalInput | null {
  const cost = costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;
  const heldMerge = acc.merge !== null && !acc.standingReverted &&
    (acc.revertMs === null || acc.merge.atMs > acc.revertMs);
  if (heldMerge) {
    const merge = acc.merge!;
    const dispatch = dispatchBefore(acc, merge.mergedAtMs);
    if (dispatch === null) return null;
    return {
      jobId: id, pool: dispatch.lane !== null && POOL_PATTERN.test(dispatch.lane) ? dispatch.lane : null,
      repo: acc.repo !== null && REPO_PATTERN.test(acc.repo) ? acc.repo : null,
      merged: true, dispatchedAt: iso(dispatch.ms), mergedAt: iso(merge.mergedAtMs),
      costUsd: cost,
      ...ciWallEvidence(acc, dispatch.ms, merge.mergedAtMs),
    };
  }
  // A standing-reverted held merge resolves like a row-level revert: the
  // merge's own GitHub stamp bounds the dispatch lookup — the revert's
  // ledger time is not recorded in the standing set, and the merge stamp
  // is the latest outcome time the fold can prove.
  const closedMs = Math.max(acc.closedMs ?? 0, acc.revertMs ?? 0,
    acc.standingReverted && acc.merge !== null ? acc.merge.mergedAtMs : 0);
  if (closedMs > 0) {
    const dispatch = dispatchBefore(acc, closedMs);
    if (dispatch === null) return null;
    return {
      jobId: id, pool: dispatch.lane !== null && POOL_PATTERN.test(dispatch.lane) ? dispatch.lane : null,
      repo: acc.repo !== null && REPO_PATTERN.test(acc.repo) ? acc.repo : null,
      merged: false, dispatchedAt: iso(dispatch.ms), mergedAt: null,
      costUsd: cost,
      ...ciWallEvidence(acc, dispatch.ms, closedMs),
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
    const costs = spend.state === 'read' ? foldSpendCosts(spend.text) : undefined;

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
