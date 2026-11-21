import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { readLaneScores, type LaneScoresRead } from '../eval/passk.js';

// Read-only recorded job outcomes from the newest ROUTER_OUTCOME_LEDGER_LIMIT
// bytes of <runs>/metrics/jobs.jsonl, joined with the per-call spend ledger
// <runs>/metrics/api-spend.jsonl and the work-market decision journal
// <runs>/metrics/work-market.jsonl under the same bound. Recovered from the
// router-outcome slice of #6794 (head f9e484e87ec2). Scope is deliberately
// bounded: no routing, ranking, tuning, weights, or network. `passk` joins
// each outcome's (lane, model) to the published eval.lane-scores.v1
// projection — advisory evidence only; a missing, degraded or ambiguous
// score leaves passk null. jobs.jsonl rows never carry work_class, so the
// fold fills it from each job's latest work-market route_decision row — the
// market's own recorded classification — while an explicit jobs-row
// work_class always wins. The ledgers are append-only and unbounded, so each
// read retains a tail window: an oversized ledger reports truncated:true (or
// spend_truncated/market_truncated for the joined sources) and folds only
// the retained rows, never a refused read. jobs.jsonl finish rows carry
// cost:null by design, so cost_usd is populated from api-spend rows naming
// the job — the same job|job_id|id attribution and cost_usd|usd|cost
// precedence the fleet spend readers already use — and stays null when no
// call reported a cost. `reverted` also joins the authority ledger's verified
// evidence index: a `revert:landed` row undoing a `merge:landed` landing marks
// the merged PR's outcome reverted through its unambiguous jobs-ledger PR URL
// claim — the fleet's own revert record, which jobs.jsonl rows never carry.

/** Newest-bytes bound retained from the append-only jobs ledger. */
export const ROUTER_OUTCOME_LEDGER_LIMIT = 16 * 1024 * 1024;
export const ROUTER_OUTCOME_LEDGER_RELATIVE = join('metrics', 'jobs.jsonl');
export const ROUTER_SPEND_LEDGER_RELATIVE = join('metrics', 'api-spend.jsonl');
export const ROUTER_MARKET_LEDGER_RELATIVE = join('metrics', 'work-market.jsonl');

export interface RouterOutcome {
  schema: 'router.outcome.v1';
  job_id: string;
  lane: string | null;
  model: string | null;
  tier: string | null;
  /**
   * work_class recorded on a jobs.jsonl row when present; otherwise the
   * latest work-market route_decision class for the job; null when neither
   * ledger recorded one — unknown stays null, never derived.
   */
  work_class: string | null;
  /**
   * true on explicit MERGED merge evidence — a MERGED terminal phase across
   * phase|state|outcome|status|result|conclusion, or a 'merged' event name
   * when no phase field resolves — or merged:true; false on CLOSED evidence
   * likewise or merged:false; else null. A resolved phase stays
   * authoritative over the event name, and mergedAt/closedAt stay the
   * preferred stamps on terminal rows.
   */
  merged: boolean | null;
  /**
   * true on explicit revert evidence — reverted:true, a revert event name or
   * terminal REVERT/REVERTED state, a parseable reverted_at/revertedAt stamp,
   * or a verified authority-ledger revert:landed undoing the merge the job's
   * unambiguous PR URL claim names; false only on an explicit reverted:false
   * with no positive evidence; else null. Sticky-true like metrics-ingest: a
   * recorded revert is never contradicted by a later reverted:false.
   */
  reverted: boolean | null;
  ci_first_pass: boolean | null;
  review_findings: { fixed: number; rejected: number; ignored: number } | null;
  /**
   * USD cost recorded for the job: an explicit cost field on a jobs.jsonl row
   * (cost_usd|usd|cost) wins; otherwise the sum of api-spend.jsonl call costs
   * naming the job. Null when neither source reported a cost — a job whose
   * calls carried no cost is unknown, never zero. May include
   * collector-estimated costs (cost_estimated rows still report a USD figure).
   */
  cost_usd: number | null;
  wall_s: number | null;
  /**
   * Recorded usage total in tokens — the finish row's `tokens_total`/
   * `tokensTotal` spelling. Newest explicit row wins like cost_usd and
   * wall_s. Null when no jobs row recorded one; never derived from cost
   * or event names.
   */
  tokens_total: number | null;
  /**
   * Recorded opened-to-merged seconds — the jobs-ledger `ttm_s`/`ttmS`
   * dialect the fleet's merge-pace, merge-graph, throughput, eval-report and
   * job-activity readers share. It belongs to the merge verdict, not to the
   * job's rows in general: the fold takes it from the row that last won the
   * merge verdict (the same newest-timestamp rule `merged` uses), only when
   * that verdict is a merge, and a later winning verdict replaces it
   * wholesale — a close clears it and a newer merge row without the field
   * leaves it null rather than keeping a stale figure. Null when no
   * standing merge recorded one; never derived from wall_s or timestamps.
   */
  ttm_s: number | null;
  /**
   * Finish-row productivity verdicts, newest explicit row wins like cost_usd
   * and wall_s. `empty` is the boolean a finish row records for its diff
   * check (true = the run produced no diff); `exit_code` is the worker's
   * recorded exit status — negative values are signal exits and stay
   * recorded; `failure_class` is the finish row's recorded failure
   * classification — `failure_class`, then `failure_reason`, then
   * `pool_error`, the precedence the skill-nudge ledger reader shares —
   * accepted only in the bounded identifier shape (values outside it are
   * skipped, never guessed or recorded raw); `empty_class` is the finish
   * row's recorded empty-diff classification in dispatchd's closed
   * classify_empty vocabulary. All stay null when no jobs row
   * recorded them — unknown, never inferred from merged state, PR URLs or
   * event names.
   */
  empty: boolean | null;
  exit_code: number | null;
  failure_class: string | null;
  /**
   * The finish row's recorded empty-diff classification — dispatchd's
   * `classify_empty` verdict (contrib/mac/launch_precheck.py), the same
   * triage its 24h rollup uses for `empty_error_rate`: `no_diff` is a
   * clean exit that produced nothing publishable (a healthy no-op),
   * `error` is a nonzero exit or pool error (the lane-penalizing
   * infrastructure share), `unknown` means no exit status was recorded
   * (a possible capture gap, not blamed on the prompt). The vocabulary is
   * closed — unrecognized spellings are skipped, never recorded raw — and
   * like failure_class the newest row carrying a recognized value wins;
   * a later finish row without one keeps it. Null when no jobs row
   * recorded one.
   */
  empty_class: string | null;
  /** The lane+model's pass^k (passPowK) from the latest eval.lane-scores.v1 projection; null when unknown. */
  passk: number | null;
}

export type LedgerReadState = 'read' | 'missing' | 'unreadable' | 'not-file' | 'too-large';

export type LedgerRead = { state: 'read'; text: string } | { state: Exclude<LedgerReadState, 'read'> };

export type LedgerTailRead =
  | { state: 'read'; text: string; truncated: boolean }
  | { state: 'missing' | 'unreadable' | 'not-file' };

/**
 * Bounded read of one regular file. O_NOFOLLOW refuses a symlink at the final path
 * component (reported as 'unreadable'); only ENOENT is 'missing'. Anything past `limit`
 * bytes is 'too-large', never truncated and parsed.
 */
export async function readLedgerFile(path: string, limit = ROUTER_OUTCOME_LEDGER_LIMIT): Promise<LedgerRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: 'not-file' };
    if (stat.size > limit) return { state: 'too-large' };
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > limit ? { state: 'too-large' } : { state: 'read', text: bytes.subarray(0, length).toString('utf8') };
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close();
  }
}

/**
 * Bounded read of the newest `maxBytes` of one regular file, same symlink and
 * file-type refusals as readLedgerFile. When the file exceeds the bound the
 * first (cut) line is dropped so every returned line is whole; a window with no
 * newline at all yields empty text. `truncated` is true exactly when older
 * bytes were not read.
 */
export async function readLedgerTail(path: string, maxBytes = ROUTER_OUTCOME_LEDGER_LIMIT): Promise<LedgerTailRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: 'not-file' };
    const truncated = stat.size > maxBytes;
    const start = truncated ? stat.size - maxBytes : 0;
    const length = stat.size - start;
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    let text = bytes.subarray(0, offset).toString('utf8');
    if (truncated) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return { state: 'read', text, truncated };
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close();
  }
}

type Row = Record<string, unknown>;
const str = (r: Row, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
/** Exit statuses are safe integers of either sign — dispatchd records signal exits as negatives. */
const exitStatus = (v: unknown): number | null => Number.isSafeInteger(v) ? v as number : null;
/** Failure classifications join only bounded identifier-shaped labels; anything else is skipped, never recorded raw. */
const FAILURE_CLASS = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
/**
 * The finish row's recorded failure classification, in the skill-nudge
 * precedence: `failure_class`, then `failure_reason`, then `pool_error`
 * (snake_case before camelCase within each). dispatchd writes `failure_class`
 * only for the devin pool, so without the fallbacks every other lane's
 * classified cause — launch_timeout, provider_*, agent_exit_nonzero,
 * exit_status_missing, or a pool error like rate_limit — folded to null.
 */
const FAILURE_CLASS_KEYS = ['failure_class', 'failureClass', 'failure_reason', 'failureReason', 'pool_error', 'poolError'] as const;
const failureClass = (r: Row): string | null => {
  const v = str(r, ...FAILURE_CLASS_KEYS);
  return v !== null && FAILURE_CLASS.test(v) ? v : null;
};

/**
 * The finish row's recorded empty-diff classification. dispatchd writes
 * `empty_class` from launch_precheck.classify_empty — a closed three-value
 * vocabulary (EMPTY_NO_DIFF/EMPTY_ERROR/EMPTY_UNKNOWN), so unlike
 * failure_class the fold accepts only those labels: an unrecognized
 * spelling is not evidence of a known class and stays null. snake_case
 * before camelCase, the same dialect tolerance the other finish fields use.
 */
const EMPTY_CLASS_KEYS = ['empty_class', 'emptyClass'] as const;
const EMPTY_CLASSES: ReadonlySet<string> = new Set(['no_diff', 'error', 'unknown']);
const emptyClass = (r: Row): string | null => {
  const v = str(r, ...EMPTY_CLASS_KEYS);
  return v !== null && EMPTY_CLASSES.has(v) ? v : null;
};

// Revert evidence uses the same field vocabulary the fleet ledger readers
// already honor: event names (event/type/kind), terminal state fields
// (phase/state/outcome/status/result/conclusion) and the reverted_at /
// revertedAt stamps (ask status stream and outcome metrics dialects).
const REVERT_NAMES: ReadonlySet<string> = new Set(['revert', 'reverted']);
const REVERT_EVENT_KEYS = ['event', 'type', 'kind'];
/**
 * jobs.jsonl terminal-phase dialect: phase|state|outcome|status plus the
 * producer aliases result|conclusion — the same field set and order the
 * fleet's shared ledgerPhase accessor and sibling outcome readers accept.
 * Merge and revert resolution share it.
 */
const PHASE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const;
const hasRevertName = (r: Row, keys: readonly string[]): boolean =>
  keys.some(k => {
    const v = r[k];
    return typeof v === 'string' && REVERT_NAMES.has(v.trim().toLowerCase());
  });
const hasRevertStamp = (r: Row): boolean =>
  ['reverted_at', 'revertedAt'].some(k => {
    const v = r[k];
    return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Date.parse(v));
  });

/**
 * jobs.jsonl timestamp dialect: ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt, with mergedAt/closedAt preferred on terminal rows —
 * the same field set dispatchd `_vc_pick` and metrics/loop accept.
 */
const LEDGER_TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
/** Timestamp keys for a row in the given phase; MERGED prefers mergedAt, CLOSED closedAt. */
const ledgerTsKeys = (phase: string): readonly string[] => {
  const preferred = phase === 'MERGED' ? 'mergedAt' : phase === 'CLOSED' ? 'closedAt' : null;
  return preferred === null ? LEDGER_TS_KEYS : [preferred, ...LEDGER_TS_KEYS.filter(k => k !== preferred)];
};

/**
 * Event names that carry a terminal merge verdict when no phase field
 * resolves — the job-outcomes convention ('merged'/'closed'). A resolved
 * phase always stays authoritative over the event name, and every other
 * event or phase spelling resolves nothing: unknown stays unknown.
 */
const OUTCOME_EVENT_STATES: Readonly<Record<string, string>> = { merged: 'MERGED', closed: 'CLOSED' };

/** Uppercased terminal phase for merge resolution; the event name only when no phase field resolves. */
const mergePhase = (r: Row): string => {
  const phase = (str(r, ...PHASE_KEYS) ?? '').toUpperCase();
  if (phase !== '') return phase;
  return OUTCOME_EVENT_STATES[(str(r, 'event', 'type', 'kind') ?? '').toLowerCase()] ?? '';
};

/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;

/** `owner/repo#n` (lowercase repo) for a pull URL; null when the URL is not that shape. */
function pullRequestKey(url: string): string | null {
  const m = GITHUB_PULL_URL.exec(url);
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}#${m[3]}` : null;
}

/** Landing ids are `${repo}#${prNumber}@${mergeSha12}` (fleet/host-merge.ts landingId()). */
const LANDING_PR = /^([^#@\s]+)#([1-9]\d*)@/;

/**
 * The evidence-row fields the authority revert join reads — a structural
 * subset of the authority ledger's LedgerEvidenceRow, declared locally so
 * callers and tests never import the Tier-1 ledger module for a read-only
 * join. LedgerEvidenceRow rows are assignable as given.
 */
export interface RouterOutcomeEvidenceRow {
  kind: string;
  landingId: string | null;
  revertsLandingId?: string | null;
}

/**
 * prKey-form (`owner/repo#n`, lowercase repo) identities of merged PRs the
 * authority ledger records as reverted: a `revert:landed` evidence row whose
 * `revertsLandingId` resolves to a `merge:landed` row's landing id. The rows
 * are the chain-verified index — a broken chain still contributes only
 * hash-verified prefix entries. Unparseable landing ids, reverts targeting
 * non-merge landings and merge rows reclassified as reverts contribute
 * nothing: unknown stays unknown.
 */
export function authorityRevertedPrKeys(evidence: readonly RouterOutcomeEvidenceRow[]): Set<string> {
  const merges = new Map<string, string>();
  for (const row of evidence) {
    if (row.kind !== 'merge:landed' || row.landingId === null) continue;
    const m = LANDING_PR.exec(row.landingId);
    if (m) merges.set(row.landingId, `${m[1]!.toLowerCase()}#${m[2]}`);
  }
  const keys = new Set<string>();
  for (const row of evidence) {
    if (row.kind !== 'revert:landed') continue;
    const target = row.revertsLandingId;
    if (target == null) continue;
    const key = merges.get(target);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

export interface RouterOutcomeFold {
  outcomes: RouterOutcome[];
  /** Non-blank lines that were not a JSON object. Skipped, never attached. */
  malformed_rows: number;
  /** Rows with no job identity that could not be attached. */
  unattached_rows: number;
  /** PR URLs claimed by more than one job; URL-only rows for them are not attached to any job. */
  ambiguous_urls: number;
}

export interface RouterOutcomeFoldOptions {
  /** Resolve the advisory pass^k score for a (lane, model) pair; absent or null stays null. */
  passkFor?: (lane: string, model: string) => number | null;
  /**
   * Resolve the market-recorded work_class for a job id; consulted only
   * when no jobs.jsonl row carried one. Absent or null/empty stays null.
   */
  workClassFor?: (jobId: string) => string | null;
  /**
   * `owner/repo#n` (lowercase repo) identities of merged PRs recorded as
   * reverted — e.g. `authorityRevertedPrKeys` over the authority ledger's
   * verified evidence index. A jobs row whose PR URL claim resolves
   * unambiguously to its own job and canonicalizes to one of these keys
   * marks the outcome `reverted: true` (sticky-true); ambiguous or
   * foreign claims never mark. Absent means no authority join.
   */
  revertedPrKeys?: ReadonlySet<string>;
}

/** Folds JSONL text into one outcome per job. Explicit fields only; nothing inferred. */
export function foldRouterOutcomes(text: string, opts: RouterOutcomeFoldOptions = {}): RouterOutcomeFold {
  const rows: Row[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) rows.push(value as Row);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  const jobId = (r: Row) => str(r, 'job', 'job_id', 'jobId', 'id');
  const prUrl = (r: Row) => str(r, 'url', 'pr_url', 'prUrl', 'pr');

  // A PR URL resolves to a job only when exactly one job claims it.
  const claims = new Map<string, Set<string>>();
  for (const r of rows) {
    const j = jobId(r), u = prUrl(r);
    if (j && u) claims.set(u, (claims.get(u) ?? new Set()).add(j));
  }
  const ambiguous = new Set([...claims].filter(([, jobs]) => jobs.size > 1).map(([u]) => u));
  const urlToJob = new Map([...claims].filter(([u, jobs]) => !ambiguous.has(u) && jobs.size === 1)
    .map(([u, jobs]) => [u, [...jobs][0]!] as const));

  const outcomes = new Map<string, RouterOutcome>();
  const mergedAt = new Map<string, number>();
  let unattached = 0;
  for (const r of rows) {
    const u = prUrl(r);
    const j = jobId(r) ?? (u ? urlToJob.get(u) : undefined);
    if (!j) { unattached++; continue; }
    const o: RouterOutcome = outcomes.get(j) ?? {
      schema: 'router.outcome.v1', job_id: j, lane: null, model: null, tier: null, work_class: null,
      merged: null, reverted: null, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null,
      tokens_total: null, ttm_s: null, empty: null, exit_code: null, failure_class: null, empty_class: null, passk: null,
    };
    o.lane = str(r, 'lane', 'pool', 'arm') ?? o.lane;
    o.model = str(r, 'model') ?? o.model;
    o.tier = str(r, 'tier') ?? o.tier;
    o.work_class = str(r, 'work_class') ?? o.work_class;
    const state = mergePhase(r);
    const merged = state === 'MERGED' ? true : state === 'CLOSED' ? false : typeof r['merged'] === 'boolean' ? r['merged'] : null;
    if (merged !== null) {
      const ts = Date.parse(str(r, ...ledgerTsKeys(state)) ?? '') || 0;
      if (ts >= (mergedAt.get(j) ?? -1)) {
        o.merged = merged;
        mergedAt.set(j, ts);
        // ttm_s is merge evidence: only the row that stands as the merge
        // verdict supplies it, so a close clears it and a non-merge row's
        // figure is never attached (the sibling fleet readers gate the same
        // way). The newest winning row replaces it wholesale.
        o.ttm_s = merged === true ? num(r['ttm_s']) ?? num(r['ttmS']) : null;
      }
    }
    // Sticky-true, matching metrics-ingest: any recorded revert evidence wins
    // and a later reverted:false cannot undo it; explicit false only stands
    // when no positive evidence exists anywhere in the job's rows.
    if (o.reverted !== true) {
      if (r['reverted'] === true || hasRevertStamp(r) || hasRevertName(r, REVERT_EVENT_KEYS) || hasRevertName(r, PHASE_KEYS)) {
        o.reverted = true;
      } else if (r['reverted'] === false) {
        o.reverted = false;
      }
      // The authority-ledger join marks only through the row's own unambiguous
      // PR claim: urlToJob.get(u) === j means this job is the URL's single
      // claimant, so a reverted pull can never mark a foreign or contested job.
      if (o.reverted !== true && u !== null && urlToJob.get(u) === j && opts.revertedPrKeys !== undefined) {
        const key = pullRequestKey(u);
        if (key !== null && opts.revertedPrKeys.has(key)) o.reverted = true;
      }
    }
    if (typeof r['ci_first_pass'] === 'boolean') o.ci_first_pass = r['ci_first_pass'];
    o.cost_usd = num(r['cost_usd']) ?? num(r['usd']) ?? num(r['cost']) ?? o.cost_usd;
    o.wall_s = num(r['wall_s']) ?? o.wall_s;
    o.tokens_total = num(r['tokens_total']) ?? num(r['tokensTotal']) ?? o.tokens_total;
    if (typeof r['empty'] === 'boolean') o.empty = r['empty'];
    o.exit_code = exitStatus(r['exit_code']) ?? exitStatus(r['exitCode']) ?? o.exit_code;
    o.failure_class = failureClass(r) ?? o.failure_class;
    o.empty_class = emptyClass(r) ?? o.empty_class;
    const f = r['review_findings'];
    if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
      const fixed = count((f as Row)['fixed']), rejected = count((f as Row)['rejected']), ignored = count((f as Row)['ignored']);
      if (fixed !== null && rejected !== null && ignored !== null) o.review_findings = { fixed, rejected, ignored };
    }
    outcomes.set(j, o);
  }
  if (opts.passkFor || opts.workClassFor) {
    for (const o of outcomes.values()) {
      if (opts.passkFor && o.lane !== null && o.model !== null) {
        const score = opts.passkFor(o.lane, o.model);
        o.passk = typeof score === 'number' && Number.isFinite(score) ? score : null;
      }
      if (opts.workClassFor && o.work_class === null) {
        const workClass = opts.workClassFor(o.job_id);
        if (typeof workClass === 'string' && workClass.trim()) o.work_class = workClass.trim();
      }
    }
  }
  return {
    outcomes: [...outcomes.values()],
    malformed_rows: malformed,
    unattached_rows: unattached,
    ambiguous_urls: ambiguous.size,
  };
}

/**
 * Folds api-spend.jsonl text into per-job USD cost sums — the dispatch
 * collector's per-call spend feed. A row attributes to a job through
 * job|job_id|id and reports cost as cost_usd|usd|cost, the precedence the
 * fleet spend readers (runs-job-cost, runs-resource-ledger) already use.
 * Rows that are not objects, name no job, or report no usable cost are
 * skipped; a job whose calls never reported a cost stays absent from the map
 * so its outcome keeps cost_usd null — unknown, never zero. Estimated costs
 * (cost_estimated) still report a USD figure and count toward the sum.
 */
export function foldSpendCosts(text: string): Map<string, number> {
  const costs = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Row;
    const j = str(r, 'job', 'job_id', 'id');
    if (!j) continue;
    const cost = num(r['cost_usd']) ?? num(r['usd']) ?? num(r['cost']);
    if (cost === null) continue;
    costs.set(j, (costs.get(j) ?? 0) + cost);
  }
  return costs;
}

/** work_class joins only values shaped like the route identifiers weight proposals group on. */
const MARKET_WORK_CLASS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Folds work-market.jsonl route_decision rows into each job's latest recorded
 * work_class. The dispatcher re-decides every waiting job each tick, so rows
 * collapse to the newest timestamp per job — the same latest-decision rule
 * the unfed report applies. Only work-market.v1 route_decision rows with a
 * bounded job id, a finite epoch-seconds ts and a route-identifier-shaped
 * work_class count; every other row is skipped, never guessed. The class is
 * the market's own classification of the job (declared or derived from its
 * requirements), recorded whether or not a lane was chosen.
 */
export function foldRouteDecisionWorkClasses(text: string): Map<string, string> {
  const latest = new Map<string, { workClass: string; ts: number }>();
  for (const line of text.split('\n')) {
    // Cheap prefilter: route decisions are the bulk of the file.
    if (!line.includes('"route_decision"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Row;
    if (row['schema'] !== 'work-market.v1' || row['event'] !== 'route_decision') continue;
    const job = row['job'];
    if (typeof job !== 'string' || job.length === 0 || job.length > 200) continue;
    const ts = row['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    const workClass = row['work_class'];
    if (typeof workClass !== 'string' || !MARKET_WORK_CLASS.test(workClass)) continue;
    const prev = latest.get(job);
    if (prev !== undefined && prev.ts >= ts) continue;
    latest.set(job, { workClass, ts });
  }
  return new Map([...latest].map(([job, entry]) => [job, entry.workClass]));
}

export interface RouterOutcomeRead extends RouterOutcomeFold {
  /** 'read' is the only state with trustworthy outcomes; everything else is an unknown ledger. */
  state: LedgerReadState;
  path: string;
  /** Health of the eval.lane-scores.v1 projection behind `passk`; 'missing' or 'degraded' means every passk is null. */
  eval_state: LaneScoresRead['state'];
  /**
   * Health of the api-spend.jsonl tail behind spend-derived `cost_usd`.
   * Anything but 'read' means no spend costs were joined — outcomes keep only
   * explicit ledger cost fields, never a fabricated or zeroed figure.
   */
  spend_state: Exclude<LedgerReadState, 'too-large'>;
  /**
   * True when the spend ledger exceeded the retained tail: joined per-job
   * costs cover only the newest bytes and are lower bounds, never totals.
   */
  spend_truncated: boolean;
  /**
   * Health of the work-market.jsonl tail behind work_class joins from
   * route_decision rows. Anything but 'read' means no market classes were
   * joined — outcomes keep only explicit jobs-ledger work_class fields.
   */
  market_state: Exclude<LedgerReadState, 'too-large'>;
  /**
   * True when the market ledger exceeded the retained tail: joined classes
   * cover only the newest bytes, so older decisions read as unclassified.
   */
  market_truncated: boolean;
  /**
   * True when the ledger exceeded the retained tail: the fold, and so every
   * count on this read, covers only the newest ROUTER_OUTCOME_LEDGER_LIMIT
   * bytes — a lower bound on the full history, never a claimed total.
   */
  truncated: boolean;
}

/**
 * Index lane-score rows by (lane, model). A duplicated pair is ambiguous and resolves
 * to null; rows whose passPowK is itself null stay null. Absent or unhealthy
 * projections yield no lookup at all.
 */
function laneScoreLookup(read: LaneScoresRead): ((lane: string, model: string) => number | null) | undefined {
  if (read.state !== 'healthy' || !read.scores) return undefined;
  const index = new Map<string, number | null>();
  const ambiguous = new Set<string>();
  for (const row of read.scores.lanes) {
    const key = JSON.stringify([row.lane, row.model]);
    if (ambiguous.has(key) || index.has(key)) { index.delete(key); ambiguous.add(key); continue; }
    index.set(key, row.passPowK);
  }
  return (lane, model) => {
    const key = JSON.stringify([lane, model]);
    return ambiguous.has(key) ? null : index.get(key) ?? null;
  };
}

/**
 * The authority ledger's verified evidence index, read lazily so fold-only
 * consumers never load the ledger module. Any failure degrades to no join —
 * the same as an empty ledger, never a fabricated revert.
 */
async function liveAuthorityEvidence(): Promise<readonly RouterOutcomeEvidenceRow[]> {
  try {
    const { ledgerSnapshot } = await import('../authority/ledger.js');
    return ledgerSnapshot('cached').index.evidence;
  } catch {
    return [];
  }
}

/**
 * Reads the newest ROUTER_OUTCOME_LEDGER_LIMIT bytes of
 * <runsDir>/metrics/jobs.jsonl plus the same bound of
 * <runsDir>/metrics/api-spend.jsonl and <runsDir>/metrics/work-market.jsonl.
 * `runsDir` defaults to ASHLR_RUNS_DIR,
 * then ~/.ashlr-runs, and must be absolute when given. `ashlarDir` is the
 * ASHLR root holding eval/passk/lane-scores.json (default ASHLR_HOME, then
 * ~/.ashlr). A missing or unreadable jobs ledger yields state != 'read' with
 * no outcomes, so callers can tell unknown input from a successfully read
 * empty ledger; a ledger larger than the bound reads its tail and reports
 * truncated:true. The spend and market ledgers degrade independently:
 * spend_state and market_state report their health, spend-derived cost_usd
 * fills only outcomes whose explicit ledger cost stayed null, and
 * market-derived work_class fills only outcomes whose jobs rows recorded
 * none — a missing joined ledger never zeroes, guesses or blocks the jobs
 * fold. `reverted` additionally joins the authority ledger's verified
 * evidence index (`authorityRevertedPrKeys`): a fleet merge the ledger
 * records as reverted marks its outcome through the job's unambiguous PR
 * URL claim, so held-merge tallies see reverts jobs.jsonl never writes.
 */
export async function readRouterOutcomes(opts: {
  runsDir?: string;
  lane?: string;
  ashlarDir?: string;
  /**
   * Authority-ledger evidence rows behind the revert join. Absent reads the
   * live `ledgerSnapshot('cached')` verified index; `null` skips the join;
   * an explicit array is used as given (tests). Only hash-verified rows ever
   * contribute, so a broken chain still marks only authentic reverts.
   */
  authorityEvidence?: readonly RouterOutcomeEvidenceRow[] | null;
} = {}): Promise<RouterOutcomeRead> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new RangeError('runsDir must be an absolute path');
  if (opts.ashlarDir !== undefined && !isAbsolute(opts.ashlarDir)) throw new RangeError('ashlarDir must be an absolute path');
  const laneScores = readLaneScores({ rootDir: opts.ashlarDir });
  const path = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const read = await readLedgerTail(path);
  const empty: RouterOutcomeFold = { outcomes: [], malformed_rows: 0, unattached_rows: 0, ambiguous_urls: 0 };
  const spendRead = await readLedgerTail(join(runsDir, ROUTER_SPEND_LEDGER_RELATIVE));
  const spendState = spendRead.state;
  const spendTruncated = spendRead.state === 'read' ? spendRead.truncated : false;
  const marketRead = await readLedgerTail(join(runsDir, ROUTER_MARKET_LEDGER_RELATIVE));
  const marketState = marketRead.state;
  const marketTruncated = marketRead.state === 'read' ? marketRead.truncated : false;
  if (read.state !== 'read') {
    return { ...empty, state: read.state, path, eval_state: laneScores.state,
      spend_state: spendState, spend_truncated: spendTruncated,
      market_state: marketState, market_truncated: marketTruncated, truncated: false };
  }
  const workClasses = marketRead.state === 'read'
    ? foldRouteDecisionWorkClasses(marketRead.text)
    : new Map<string, string>();
  const authorityEvidence = opts.authorityEvidence === undefined
    ? await liveAuthorityEvidence()
    : opts.authorityEvidence;
  const folded = foldRouterOutcomes(read.text, {
    passkFor: laneScoreLookup(laneScores),
    workClassFor: (jobId) => workClasses.get(jobId) ?? null,
    revertedPrKeys: authorityEvidence === null ? undefined : authorityRevertedPrKeys(authorityEvidence),
  });
  if (spendRead.state === 'read') {
    const costs = foldSpendCosts(spendRead.text);
    for (const o of folded.outcomes) {
      if (o.cost_usd !== null) continue;
      const sum = costs.get(o.job_id);
      if (sum !== undefined) o.cost_usd = sum;
    }
  }
  const outcomes = opts.lane === undefined ? folded.outcomes : folded.outcomes.filter(o => o.lane === opts.lane);
  return { ...folded, outcomes, state: 'read', path, eval_state: laneScores.state,
    spend_state: spendState, spend_truncated: spendTruncated,
    market_state: marketState, market_truncated: marketTruncated, truncated: read.truncated };
}
