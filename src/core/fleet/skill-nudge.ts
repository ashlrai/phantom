/**
 * Deterministic shadow learning from structured, chronological job metadata:
 * the draft rules above plus the jobs.jsonl fold and daemon sync that feed
 * them real fleet evidence. Candidates stay shadow records; nothing here
 * attests, promotes, or routes on them.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillCard } from '../types.js';
import type { MetricsJob } from './metrics-ingest.js';
import { ledgerEventName, ledgerPhase } from './empty-cause.js';
import { isNodePoolLedgerRow, ledgerEventTs } from './jobs-ledger-dialect.js';
import { readSkillCardCorpus, recordSkillCard, sanitizeSkillCard } from './skill-records.js';
import { hasRevertEvidence } from './slot-yield.js';
import {
  readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE, type LedgerReadState,
} from '../router/outcomes.js';

export type SkillNudgeJob = Pick<MetricsJob,
  'id' | 'lane' | 'outcome' | 'reverted' | 'retries' | 'recuts' | 'failureClass'>;

const validId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const positiveCount = (value: number | undefined): boolean =>
  value !== undefined && Number.isSafeInteger(value) && value > 0;

/**
 * Input order is oldest first. Duplicate job ids count once; conflicting rows
 * are ignored. A recurring class needs three distinct failed jobs before
 * a successful recovery. Only merged, non-reverted jobs seed drafts.
 */
export function draftSkillNudges(jobs: readonly SkillNudgeJob[], ts: string): SkillCard[] {
  const byId = new Map<string, SkillNudgeJob>();
  const conflicts = new Set<string>();
  for (const job of jobs) {
    if (!validId(job.id) || !hasKnownLane(job.lane) ||
      (job.failureClass !== undefined && !validId(job.failureClass))) continue;
    const old = byId.get(job.id);
    if (old && JSON.stringify(old) !== JSON.stringify(job)) conflicts.add(job.id);
    else byId.set(job.id, job);
  }
  const seen = new Map<string, string[]>();
  const drafts = new Map<string, SkillCard>();
  for (const job of byId.values()) {
    if (conflicts.has(job.id) || !['merged', 'failed', 'empty', 'cancelled'].includes(job.outcome ?? '')) continue;
    const failureClass = job.failureClass?.toLowerCase() === 'unknown' ? undefined : job.failureClass;
    const key = JSON.stringify([job.lane, failureClass ?? null]);
    const sources = seen.get(key) ?? [];
    if (failureClass && job.outcome === 'failed') sources.push(job.id);
    seen.set(key, sources);
    if (job.outcome !== 'merged' || job.reverted === true) continue;
    const retry = positiveCount(job.retries), recut = positiveCount(job.recuts);
    if (!retry && !recut && !(failureClass && sources.length >= 3)) continue;
    const trigger = failureClass
      ? `${job.lane}: recover from ${failureClass}`
      : `${job.lane}: recover after ${recut ? 'recut' : 'retry'}`;
    const steps = [
      `Inspect the structured failure classification for ${job.lane}.`,
      `Address ${failureClass ?? 'the failed attempt'} before retrying or recutting.`,
      'Run the affected verification and confirm a successful outcome before reuse.',
    ];
    const skillId = `skill.nudge.${createHash('sha256').update(JSON.stringify([trigger, steps])).digest('hex')}`;
    const old = drafts.get(skillId);
    // Keep the recovery that justified this draft even when failures fill the cap.
    const otherSources = new Set([...(old?.sourceJobIds ?? []), ...sources]);
    otherSources.delete(job.id);
    const sourceJobIds = [...[...otherSources].sort().slice(0, 15), job.id].sort();
    drafts.set(skillId, sanitizeSkillCard({
      schemaVersion: 1, skillId, revision: 1, ts,
      name: 'Draft recovery workflow', summary: trigger,
      status: 'candidate', source: 'imported', tags: ['skill-nudge', 'shadow'],
      trigger, steps,
      sourceJobIds,
      verification: { passed: false },
    }));
  }
  return [...drafts.values()].sort((a, b) => a.skillId.localeCompare(b.skillId));
}

function hasKnownLane(lane: string): boolean {
  return validId(lane) && lane.toLowerCase() !== 'unknown';
}

/** Append candidates to the existing ledger; never attest or promote them. */
export function nudgeSkillsFromJobs(jobs: readonly SkillNudgeJob[], ts = new Date().toISOString()): SkillCard[] {
  const corpus = readSkillCardCorpus();
  if (corpus.sourceState === 'degraded') return [];
  const existing = new Set(corpus.cards.map(card => card.skillId));
  const drafts = draftSkillNudges(jobs, ts).filter(card => !existing.has(card.skillId));
  recordSkillCard(drafts);
  // The writer is best-effort: report only candidates actually persisted.
  const persisted = new Set(readSkillCardCorpus().cards.map(card => card.skillId));
  return drafts.filter(card => persisted.has(card.skillId));
}

// ---------------------------------------------------------------------------
// jobs.jsonl fold
// ---------------------------------------------------------------------------
//
// One SkillNudgeJob is emitted per job id, sorted by the ledger position of
// its latest terminal outcome (or its last row while unresolved).
//
// Field provenance, all real ledger evidence:
//   - id/lane: job plus the last execution-side lane (enqueue/enqueued/queued rows are
//     queue hints and never set the lane).
//   - outcome: the latest terminal lifecycle phase on any row — the phase
//     fields (phase|state|outcome|status|result|conclusion via the shared
//     ledgerPhase accessor) are the producer convention (dispatchd
//     _vc_phase, metrics-outcomes reconciler rows inherit the published
//     row's event name, so the phase field decides, not the event). When no
//     phase field resolves, the event name itself can carry the verdict —
//     'merged'/'closed' outcome events and 'revert'/'reverted' names map the
//     same way job-outcomes reads them. MERGED->merged,
//     CLOSED/FAILED/ERROR->failed, DONE-NOOP and empty-family->empty,
//     CANCELLED->cancelled, REVERT/REVERTED->merged with reverted evidence.
//     PUBLISHED/OPEN and task-level words (done/skipped/deferred) never
//     resolve a job outcome.
//   - reverted: sticky hasRevertEvidence, the same rule slot-yield and the
//     router outcome fold apply — plus, when the caller supplies the
//     standing revert keys (`revertedPrKeys`: outcome-ledger, cloud-task and
//     `fleet reverts --record` detections), a merged job whose standing
//     verdict row's pull URL is claimed by exactly that job and whose
//     `owner/repo#n` key stands in the set, the unambiguous-claim join
//     outcome-learning applies.
//   - retries: dispatch attempts beyond the first (launch, batch_claim, and
//     claim rows not flagged launch_dedupe — dedupe claims pair with their
//     launch and are one attempt) plus launch_failed rows whose action is
//     'retry' (bounded launch-retry receipts for attempts that never spawned).
//   - recuts: dispatch attempts preceded by an unconsumed ready recut
//     decision. Polling the admission gate does not count as execution.
//   - failureClass: the last identifier-safe classification a finish row
//     carries (failure_class, then failure_reason, then pool_error) or a
//     launch_failed/launch_terminal reason. Prose reasons never qualify.
// Anything unresolved stays absent: no outcome means draftSkillNudges skips
// the row, exactly like an MetricsJob without a terminal outcome.

const LEDGER_JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const LEDGER_LANE_KEYS = ['lane', 'pool', 'arm'] as const;
const LEDGER_ACTION_KEYS = ['action'] as const;
/** PR URL spellings the jobs-ledger producers emit — the set outcome-learning and the router outcome fold read. */
const PR_URL_KEYS = ['url', 'pr_url', 'prUrl', 'pr'] as const;
/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;
/** Batch session ids are infrastructure and never claim a PR — the rule the sibling outcome folds apply. */
const BATCH_SESSION_PREFIX = 'RQ-BATCH-';
/** Same identifier alphabet draftSkillNudges accepts for id, lane and failureClass. */
const LEDGER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const QUEUE_HINT_EVENTS: ReadonlySet<string> = new Set(['enqueue', 'enqueued', 'queued']);
const ATTEMPT_EVENTS: ReadonlySet<string> = new Set(['launch', 'batch_claim']);
const MERGED_PHASES: ReadonlySet<string> = new Set(['MERGED']);
const FAILED_PHASES: ReadonlySet<string> = new Set(['CLOSED', 'FAILED', 'ERROR']);
const EMPTY_PHASES: ReadonlySet<string> = new Set(['DONE-NOOP', 'EMPTY', 'EMPTY_DONE', 'SKIPPED-EMPTY', 'NOOP']);
const CANCELLED_PHASES: ReadonlySet<string> = new Set(['CANCELLED', 'CANCELED']);
const REVERT_PHASES: ReadonlySet<string> = new Set(['REVERT', 'REVERTED']);

/** The resolved outcomes draftSkillNudges consumes; queued/running stay unresolved. */
type NudgeOutcome = 'merged' | 'failed' | 'empty' | 'cancelled';

interface NudgeRecoveryEvidence {
  lane: string | null;
  attempts: number;
  retryReceipts: number;
  recuts: number;
  failureClass: string | null;
}

interface NudgeJobAccum {
  evidence: NudgeRecoveryEvidence;
  verdictEvidence: NudgeRecoveryEvidence | null;
  outcome: NudgeOutcome | undefined;
  /** Canonical PR key on the standing verdict row, when available. */
  verdictPrKey: string | null;
  reverted: boolean;
  recutReady: boolean;
  lastLine: number;
  outcomeLine: number | null;
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** `owner/repo#n` (lowercase repo) for a pull URL; null when the URL is not that shape. */
function rowPrKey(row: Record<string, unknown>): string | null {
  const url = firstString(row, PR_URL_KEYS);
  const match = url === null ? null : GITHUB_PULL_URL.exec(url);
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}` : null;
}

/**
 * The standing revert-set join: a merged job whose standing verdict row's
 * pull URL is claimed by exactly that job and whose `owner/repo#n` key
 * stands in the supplied set counts as reverted — git-history reverts the
 * jobs ledger never spelled still discount the draft. Absent, empty or
 * unmatched keys change nothing, and a contested or foreign claim never
 * resolves, the same rule outcome-learning applies.
 */
function standingReverted(
  id: string,
  acc: NudgeJobAccum,
  claims: ReadonlyMap<string, ReadonlySet<string>> | null,
  keys: ReadonlySet<string> | null | undefined,
): boolean {
  if (claims === null || keys === null || keys === undefined
    || acc.outcome !== 'merged' || acc.verdictPrKey === null) return false;
  const claimants = claims.get(acc.verdictPrKey);
  return claimants?.size === 1 && claimants.has(id) && keys.has(acc.verdictPrKey);
}

/** Event names (post-normalization, lowercase) that carry a terminal verdict with no phase field. */
const EVENT_OUTCOMES: ReadonlyMap<string, NudgeOutcome> = new Map([
  ['merged', 'merged'],
  ['closed', 'failed'],
  ['revert', 'merged'],
  ['reverted', 'merged'],
]);

/**
 * The job's terminal outcome on one row: the phase fields decide first (the
 * authoritative outcome signal); when none of them names a known phase the
 * event name itself may carry the verdict, the same merged/closed mapping
 * job-outcomes applies. Revert names resolve like their phase spellings —
 * merged evidence the reverted flag then discounts.
 */
function outcomeOf(row: Record<string, unknown>): NudgeOutcome | undefined {
  const phase = ledgerPhase(row);
  if (phase !== null) {
    if (MERGED_PHASES.has(phase) || REVERT_PHASES.has(phase)) return 'merged';
    if (FAILED_PHASES.has(phase)) return 'failed';
    if (EMPTY_PHASES.has(phase)) return 'empty';
    if (CANCELLED_PHASES.has(phase)) return 'cancelled';
  }
  const event = ledgerEventName(row);
  return event === null ? undefined : EVENT_OUTCOMES.get(event);
}

/** Fixed-label failure classifications only; anything else stays unknown. */
function failureClassOf(row: Record<string, unknown>, event: string | null): string | null {
  let keys: readonly string[];
  if (event === 'finish') {
    keys = ['failure_class', 'failureClass', 'failure_reason', 'failureReason', 'pool_error', 'poolError'];
  } else if (event === 'launch_failed' || event === 'launch_terminal') {
    keys = ['reason', 'class'];
  } else {
    return null;
  }
  for (const key of keys) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const raw = value.trim();
    if (validId(raw) && raw.toLowerCase() !== 'unknown') return raw;
  }
  return null;
}

/**
 * Fold jobs.jsonl text into one SkillNudgeJob per job id, ordered by each
 * job's latest terminal outcome position (last ledger position for unresolved
 * jobs). Pure; never throws; malformed lines and rows without a usable job id
 * are ignored.
 */
export function skillNudgeJobsFromLedger(
  text: string, revertedPrKeys?: ReadonlySet<string> | null, nowMs = Date.now(),
): SkillNudgeJob[] {
  const jobs = new Map<string, NudgeJobAccum>();
  const recoveryReceipts = new Set<string>();
  // PR key -> claiming job ids, collected only when the caller supplied
  // standing revert keys — the same unambiguous-claim evidence pass
  // outcome-learning runs, so a contested or foreign PR never resolves.
  const claims = revertedPrKeys === undefined || revertedPrKeys === null || revertedPrKeys.size === 0
    ? null : new Map<string, Set<string>>();
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const id = firstString(row, LEDGER_JOB_KEYS);
    // Batch members have their own rows. The session wrapper and node-pool
    // attempt telemetry do not supply job-level recovery evidence.
    if (id === null || id.startsWith(BATCH_SESSION_PREFIX) || isNodePoolLedgerRow(row)) continue;
    const outcome = outcomeOf(row);
    const rowAt = ledgerEventTs(row, null);
    const terminalPhase = outcome === 'merged' ? 'MERGED' : outcome === 'failed' ? 'CLOSED' : null;
    const terminalAt = terminalPhase === null ? null : ledgerEventTs(row, terminalPhase);
    if ((rowAt !== null && rowAt > nowMs) || (terminalAt !== null && terminalAt > nowMs)) continue;
    const event = ledgerEventName(row);
    const dispatched = (event !== null && ATTEMPT_EVENTS.has(event))
      || (event === 'claim' && row['launch_dedupe'] !== true);
    // A replay must not move a verdict past later failures or capture
    // execution evidence recorded after the original verdict.
    const datedVerdict = outcome !== undefined && (rowAt !== null || terminalAt !== null);
    const datedRecovery = rowAt !== null && (dispatched || event === 'recut_admission');
    if (datedVerdict || datedRecovery) {
      const receipt = line.trim();
      if (recoveryReceipts.has(receipt)) continue;
      recoveryReceipts.add(receipt);
    }
    const prKey = claims === null ? null : rowPrKey(row);
    if (claims !== null && prKey !== null) {
      const set = claims.get(prKey) ?? new Set<string>();
      set.add(id);
      claims.set(prKey, set);
    }
    if (!LEDGER_ID_PATTERN.test(id)) continue;
    let acc = jobs.get(id);
    if (acc === undefined) {
      acc = {
        evidence: { lane: null, attempts: 0, retryReceipts: 0, recuts: 0, failureClass: null },
        verdictEvidence: null, outcome: undefined, verdictPrKey: null, reverted: false, recutReady: false,
        lastLine: lineNo, outcomeLine: null,
      };
      jobs.set(id, acc);
    }
    acc.lastLine = lineNo;
    const evidence = acc.evidence;
    if (event === null ? outcome !== undefined : !QUEUE_HINT_EVENTS.has(event)) {
      for (const key of LEDGER_LANE_KEYS) {
        const value = row[key];
        if (typeof value !== 'string' || !hasKnownLane(value.trim())) continue;
        evidence.lane = value.trim();
        break;
      }
    }
    if (dispatched) {
      evidence.attempts += 1;
      if (acc.recutReady) evidence.recuts += 1;
      acc.recutReady = false;
    }
    if (event === 'launch_failed' && firstString(row, LEDGER_ACTION_KEYS)?.toLowerCase() === 'retry') {
      evidence.retryReceipts += 1;
    }
    if (event === 'recut_admission') {
      acc.recutReady = firstString(row, LEDGER_ACTION_KEYS)?.toLowerCase() === 'ready';
    }
    const failureClass = failureClassOf(row, event);
    if (failureClass !== null) evidence.failureClass = failureClass;
    if (hasRevertEvidence(row)) acc.reverted = true;
    if (outcome !== undefined) {
      acc.recutReady = false;
      acc.verdictEvidence = { ...evidence };
      acc.outcome = outcome;
      acc.outcomeLine = lineNo;
      // The standing verdict row's own PR key is what the revert-set join
      // binds to — a later verdict of a different PR is a fresh merge era.
      acc.verdictPrKey = prKey;
    }
  }
  return [...jobs.entries()]
    .sort((a, b) => (a[1].outcomeLine ?? a[1].lastLine) - (b[1].outcomeLine ?? b[1].lastLine))
    .map(([id, acc]) => {
      const evidence = acc.verdictEvidence ?? acc.evidence;
      const retries = Math.max(0, evidence.attempts - 1) + evidence.retryReceipts;
      const reverted = acc.reverted || standingReverted(id, acc, claims, revertedPrKeys);
      return {
        id,
        lane: evidence.lane ?? 'unknown',
        ...(acc.outcome !== undefined ? { outcome: acc.outcome } : {}),
        ...(reverted ? { reverted: true } : {}),
        ...(retries > 0 ? { retries } : {}),
        ...(evidence.recuts > 0 ? { recuts: evidence.recuts } : {}),
        ...(evidence.failureClass !== null ? { failureClass: evidence.failureClass } : {}),
      };
    });
}

export interface SkillNudgeSyncOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as reward-feed). */
  runsDir?: string;
  /** Injected jobs-ledger tail text; skips the jobs.jsonl read when set. */
  jobsText?: string;
  /**
   * Standing revert keys (`owner/repo#n`) the caller resolved from the
   * outcome ledger, cloud tasks and the revert-outcomes scan ledger — the
   * same set outcome-learning consumes. A merged job whose standing
   * verdict row's pull URL is claimed by exactly that job and whose key
   * stands in the set folds as reverted; absent or unmatched keys change
   * nothing.
   */
  revertedPrKeys?: ReadonlySet<string> | null;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface SkillNudgeSyncResult {
  /** Health of the jobs-ledger tail; only 'read' can fold rows. */
  state: LedgerReadState | 'error';
  jobsPath: string;
  /** True when the tail dropped older bytes — early job evidence may be out of window. */
  truncated: boolean;
  /** SkillNudgeJob rows the ledger fold produced. */
  folded: number;
  /** Candidate cards nudgeSkillsFromJobs actually persisted this pass. */
  candidates: number;
}

/**
 * Refresh shadow skill-nudge candidates from the fleet jobs ledger. Runs
 * inside the daemon's skill-nudge off-tick job on the self-improvement
 * cadence; safe to call any time. Never throws: ledger problems come back as
 * `state`, write problems as `state: 'error'`.
 */
export async function syncSkillNudgesFromJobsLedger(
  opts: SkillNudgeSyncOptions = {},
): Promise<SkillNudgeSyncResult> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const jobsPath = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const empty = { jobsPath, truncated: false, folded: 0, candidates: 0 };
  try {
    const jobs = opts.jobsText !== undefined
      ? { state: 'read' as const, text: opts.jobsText, truncated: false }
      : await readLedgerTail(jobsPath);
    if (jobs.state !== 'read') return { state: jobs.state, ...empty };
    if (opts.signal?.aborted) return { state: 'read', ...empty, truncated: jobs.truncated };
    const now = (opts.now ?? (() => new Date()))();
    const folded = skillNudgeJobsFromLedger(jobs.text, opts.revertedPrKeys, now.getTime());
    const candidates = nudgeSkillsFromJobs(folded, now.toISOString());
    return { state: 'read', jobsPath, truncated: jobs.truncated, folded: folded.length, candidates: candidates.length };
  } catch {
    return { state: 'error', ...empty };
  }
}
