/**
 * eval-report.ts — RQ-SWE3-EVALFLEET-1: read-only fleet post-merge durability
 * report ("fleet IQ").
 *
 * EVALHARNESS-1 (src/core/eval/router-eval.ts) scores single routing
 * decisions against frozen job lines. This module extends the same honesty
 * stance to fleet outcomes: every merged PR is scored for what happened
 * after the merge — reverts, regressions and follow-up fixes — then rolled
 * up by lane, tier, lane+tier and repo so the weekly report can say which
 * parts of the fleet produce durable work.
 *
 * Inputs (all read-only):
 *   - the metrics jobs ledger (`~/.ashlr-runs/metrics/jobs.jsonl`):
 *     dispatchd's enqueue/claim/launch/finish/publish/outcome rows. Outcome
 *     rows keyed by PR URL carry `state` MERGED|CLOSED|OPEN, `mergedAt` and
 *     `ttm_s`; publish rows bind a job to its PR URLs.
 *   - optional gh-shaped merged-PR exports (`gh pr list --state merged
 *     --json ...` / `gh search prs --json ...`, a JSON array or JSONL):
 *     mergeCommit sha (the join key to the observation ledger),
 *     statusCheckRollup conclusions, file lists and titles for revert and
 *     overlapping-fix evidence.
 *   - the signed post-merge observation ledger rows (already resolved by the
 *     caller): adverse outcomes keyed by mergeCommit.
 *
 * Honesty rules (same stance as one-ask-reward and job-latency):
 *   - 'stable' requires the 72h observation window elapsed AND an evidence
 *     channel that covers the merge's repo; uncovered merges are
 *     'unobserved', counted and never credited or guessed;
 *   - 'pending' covers merges still inside the window with no adverse row;
 *   - durability rates resolve over resolved merges (stable + adverse) only;
 *   - group rankings sort on the Wilson lower bound, so a 1/1 lane cannot
 *     outrank a 40/41 lane;
 *   - the CI block reports raw adverse rates and a direction, never a
 *     significance claim;
 *   - nothing here merges, routes, requeues or releases credit.
 */

import { wilsonInterval } from '../eval/router-eval.js';
import { ONE_ASK_REWARD_WINDOW_MS } from './one-ask-reward.js';

export const FLEET_EVAL_REPORT_SCHEMA = 'fleet.eval-report.v1' as const;
/** Adverse post-merge observation window; shared with the one-ask reward. */
export const FLEET_EVAL_OBSERVATION_WINDOW_MS = ONE_ASK_REWARD_WINDOW_MS;
export const DEFAULT_EVAL_DAYS = 7;
export const MAX_EVAL_DAYS = 90;
const MAX_ROWS = 250_000;
const MAX_FAILED_CHECK_NAMES = 20;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Caller-resolved adverse observation rows (already signature-checked). */
export interface EvalObservationRow {
  outcome: 'reverted' | 'regressed' | 'followed-up';
  mergeCommit: string;
  confidence?: 'deterministic' | 'heuristic';
}

export interface FleetEvalReportInput {
  /** metrics/jobs.jsonl contents; null when the ledger is absent/unreadable. */
  jobsText: string | null;
  /** gh-shaped merged-PR exports; each entry is a JSON array or JSONL text. */
  prsTexts?: readonly string[];
  /** Observation ledger rows and source health, or null to skip the channel. */
  observations?: { sourceState: 'healthy' | 'missing' | 'degraded'; rows: readonly EvalObservationRow[] } | null;
  /** Report timestamp. */
  nowMs: number;
  /** Look-back length for the merged cohort and activity counters. */
  windowDays?: number;
  /** Window end; defaults to nowMs. */
  untilMs?: number;
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export type MergeDurability = 'reverted' | 'regressed' | 'followed-up' | 'stable' | 'pending' | 'unobserved';
export type CheckState = 'clean' | 'failed-checks' | 'unknown';

export interface EvalPullRequest {
  url: string;
  repo: string;
  number: number;
  jobId: string | null;
  lane: string | null;
  tier: string | null;
  jobRepo: string | null;
  model: string | null;
  mergedAt: string | null;
  /** Ledger ttm_s, or mergedAt minus the job's first dispatch timestamp. */
  ttm_s: number | null;
  ttmSource: 'ledger' | 'derived' | null;
  durability: MergeDurability;
  /** observation-ledger | gh-revert | gh-follow-up | window | none. */
  durabilityBasis: 'observation-ledger' | 'gh-revert' | 'gh-follow-up' | 'window' | 'none';
  durabilityConfidence: 'deterministic' | 'heuristic' | null;
  checks: number | null;
  failedChecks: number | null;
  checkState: CheckState;
  /** The producing job's finish row reported a nonzero exit or pool error. */
  jobFinishFailed: boolean | null;
}

export interface EvalGroupRow {
  name: string;
  launched: number;
  finished: number;
  failedFinishes: number;
  emptyFinishes: number;
  published: number;
  merged: number;
  closed: number;
  stable: number;
  reverted: number;
  regressed: number;
  followedUp: number;
  pending: number;
  unobserved: number;
  durability: { resolved: number; rate: number | null; ci95: [number, number] | null };
  revertRate: number | null;
  followUpRate: number | null;
  ttm: { measured: number; median_s: number | null; p90_s: number | null };
  lead: { measured: number; median_s: number | null; p90_s: number | null };
  checks: { clean: number; failedChecks: number; adverseWithClean: number; adverseWithFailedChecks: number };
}

export interface FleetEvalReport {
  schema: typeof FLEET_EVAL_REPORT_SCHEMA;
  generatedAt: string;
  window: { days: number; since: string; until: string };
  sources: {
    jobs: { state: 'healthy' | 'missing' | 'degraded'; rows: number; events: number; ignored: number };
    pullRequests: { state: 'absent' | 'healthy' | 'degraded'; files: number; rows: number; mergedRows: number; ignored: number };
    observations: { state: 'disabled' | 'healthy' | 'missing' | 'degraded'; rows: number };
  };
  jobs: {
    launched: number;
    finished: number;
    failedFinishes: number;
    emptyFinishes: number;
    published: number;
    merged: number;
    closed: number;
  };
  merges: {
    total: number;
    attributed: number;
    unattributed: number;
    stable: number;
    reverted: number;
    regressed: number;
    followedUp: number;
    pending: number;
    unobserved: number;
    resolved: number;
    /** stable/(stable+adverse) * 100 over resolved merges; null when none. */
    fleetIQ: number | null;
    fleetIqCi95: [number, number] | null;
  };
  timeToMerge: { measured: number; median_s: number | null; p90_s: number | null; max_s: number | null };
  mergeLead: { measured: number; median_s: number | null; p90_s: number | null; max_s: number | null };
  ci: {
    measured: number;
    unknown: number;
    clean: { merged: number; adverse: number; adverseRate: number | null };
    failedChecks: { merged: number; adverse: number; adverseRate: number | null };
    jobFinishFailed: { merged: number; adverse: number; adverseRate: number | null };
    direction: 'failed-checks-more-adverse' | 'clean-more-adverse' | 'even' | 'insufficient-data';
  };
  byLane: EvalGroupRow[];
  byTier: EvalGroupRow[];
  byLaneTier: EvalGroupRow[];
  byRepo: EvalGroupRow[];
  /** Groups with resolved merges, ranked by Wilson lower bound (most durable first). */
  ranked: { kind: 'lane' | 'tier' | 'lane+tier' | 'repo'; name: string; resolved: number; durabilityRate: number; lowerBound: number }[];
  pullRequests: EvalPullRequest[];
}

// ---------------------------------------------------------------------------
// Row helpers (same tolerant conventions as lane-reward / fleet-ttm)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const str = (row: Row, ...names: string[]): string | null => {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};
const num = (row: Row, ...names: string[]): number | null => {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
};
const ts = (row: Row, ...names: string[]): number | null => {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const EVENT = (row: Row): string => (str(row, 'event', 'type', 'kind') ?? '').toLowerCase();
const PHASE = (row: Row): string => (str(row, 'state', 'outcome', 'status') ?? '').toUpperCase();
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/;

/** Canonical join key for a GitHub PR URL; null when the value is not one. */
export function prKeyOf(value: unknown): { key: string; repo: string; number: number } | null {
  if (typeof value !== 'string') return null;
  const m = PR_URL_RE.exec(value.trim());
  if (!m) return null;
  return { key: `https://github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/pull/${m[3]}`, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

const prUrlOf = (row: Row): ReturnType<typeof prKeyOf> =>
  prKeyOf(row['url']) ?? prKeyOf(row['prUrl']) ?? prKeyOf(row['pr_url']) ?? prKeyOf(row['pr']) ?? prKeyOf(row['html_url']);

// ---------------------------------------------------------------------------
// jobs.jsonl fold
// ---------------------------------------------------------------------------

export interface RoutingRow { atMs: number; lane: string | null; tier: string | null; repo: string | null; model: string | null }
export interface FinishRow { atMs: number; failed: boolean; empty: boolean }
export interface JobFold {
  routes: RoutingRow[];
  finishes: FinishRow[];
  urls: Set<string>;
}

export interface OutcomeRow {
  state: string;
  atMs: number | null;
  ttmS: number | null;
  jobId: string | null;
  repo: string | null;
  mergeCommit: string | null;
}

/** A windowed activity event attributed to a lane/tier when the row or its job carries one. */
export interface ActivityEvent {
  kind: 'launch' | 'finish' | 'publish' | 'merged' | 'closed';
  jobId: string | null;
  lane: string | null;
  tier: string | null;
  failed: boolean;
  empty: boolean;
}

export interface LedgerFold {
  jobByUrl: Map<string, string>;
  jobs: Map<string, JobFold>;
  /** Outcome rows keyed by canonical PR URL, or `job:<id>` when no URL exists. */
  outcomes: Map<string, OutcomeRow>;
  /** Windowed activity events for group counters. */
  activity: ActivityEvent[];
  counts: { rows: number; events: number; ignored: number };
}

const ROUTING_EVENTS = new Set(['enqueue', 'claim', 'launch', 'queued']);
const FINISH_EVENTS = new Set(['finish', 'finished', 'complete', 'completed']);
const PUBLISH_EVENTS = new Set(['publish', 'published']);
const OUTCOME_EVENTS = new Set(['outcome', 'result', 'resolved', 'resolution']);

export function foldJobsLedger(text: string, sinceMs: number, untilMs: number): LedgerFold {
  const counts = { rows: 0, events: 0, ignored: 0 };
  const parsed: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    counts.rows++;
    if (parsed.length >= MAX_ROWS) { counts.ignored++; continue; }
    try {
      const row = asRow(JSON.parse(trimmed));
      if (!row) throw new Error('not an object');
      parsed.push(row);
    } catch { counts.ignored++; }
  }
  const jobOf = (row: Row): string | null => str(row, 'job', 'job_id', 'jobId', 'id');
  const jobByUrl = new Map<string, string>();
  for (const row of parsed) {
    const job = jobOf(row);
    const pr = prUrlOf(row);
    if (job && pr) jobByUrl.set(pr.key, job);
  }
  const jobs = new Map<string, JobFold>();
  const outcomes = new Map<string, OutcomeRow>();
  const activity: ActivityEvent[] = [];
  const jobFold = (id: string): JobFold => {
    let fold = jobs.get(id);
    if (!fold) { fold = { routes: [], finishes: [], urls: new Set() }; jobs.set(id, fold); }
    return fold;
  };
  /** Lane/tier for rows that do not carry them (publish/outcome): the job's latest routing row. */
  const routeOf = (jobId: string | null): { lane: string | null; tier: string | null } => {
    if (!jobId) return { lane: null, tier: null };
    const foldJob = jobs.get(jobId);
    if (!foldJob || foldJob.routes.length === 0) return { lane: null, tier: null };
    const latest = [...foldJob.routes].sort((a, b) => a.atMs - b.atMs).at(-1)!;
    return { lane: latest.lane, tier: latest.tier };
  };
  for (const row of parsed) {
    const event = EVENT(row);
    const phase = PHASE(row);
    const atMs = ts(row, 'ts', 'timestamp', 'at', 'mergedAt', 'closedAt');
    const inWindow = atMs !== null && atMs >= sinceMs && atMs < untilMs;
    const job = jobOf(row);
    const pr = prUrlOf(row);
    const outcomeRow = OUTCOME_EVENTS.has(event) || (event === '' && ['MERGED', 'CLOSED', 'OPEN'].includes(phase));
    if (ROUTING_EVENTS.has(event)) {
      counts.events++;
      const route = {
        atMs: atMs ?? 0,
        lane: str(row, 'lane', 'pool'), tier: str(row, 'tier'),
        repo: str(row, 'repo'), model: str(row, 'model'),
      };
      if (job) jobFold(job).routes.push(route);
      if (inWindow && event === 'launch') {
        activity.push({ kind: 'launch', jobId: job, lane: route.lane, tier: route.tier, failed: false, empty: false });
      }
      continue;
    }
    if (FINISH_EVENTS.has(event)) {
      counts.events++;
      const code = row['exit_code'] ?? row['exitCode'];
      const failed = typeof code === 'number' && Number.isFinite(code) ? code !== 0
        : typeof row['pool_error'] === 'string' && row['pool_error'] !== '';
      const empty = row['empty'] === true;
      if (job) jobFold(job).finishes.push({ atMs: atMs ?? 0, failed, empty });
      if (inWindow) {
        activity.push({ kind: 'finish', jobId: job, lane: str(row, 'lane', 'pool'), tier: str(row, 'tier'), failed, empty });
      }
      continue;
    }
    if (PUBLISH_EVENTS.has(event) || (!outcomeRow && phase === 'PUBLISHED')) {
      counts.events++;
      if (job && pr) jobFold(job).urls.add(pr.key);
      if (inWindow) {
        activity.push({ kind: 'publish', jobId: job, lane: str(row, 'lane', 'pool'), tier: str(row, 'tier'), failed: false, empty: false });
      }
      continue;
    }
    if (outcomeRow) {
      counts.events++;
      const url = pr ? pr.key : (job ? `job:${job}` : null);
      if (!url) { counts.ignored++; continue; }
      const mergedAtMs = ts(row, 'mergedAt') ?? atMs;
      const mergeCommitRow = row['mergeCommit'];
      const mergeCommit = str(row, 'mergeCommit', 'merge_commit_sha', 'mergeCommitOid')
        ?? (asRow(mergeCommitRow) ? str(asRow(mergeCommitRow)!, 'oid', 'sha') : null);
      const prev = outcomes.get(url);
      // Latest outcome wins; a repeated terminal row at the same ts is a dup.
      if (!prev || (mergedAtMs ?? -1) >= (prev.atMs ?? -1)) {
        outcomes.set(url, {
          state: phase, atMs: mergedAtMs, ttmS: num(row, 'ttm_s', 'ttmS'),
          jobId: job ?? (pr ? jobByUrl.get(pr.key) ?? null : null),
          repo: pr?.repo ?? str(row, 'repo'), mergeCommit,
        });
      }
      if (inWindow && (phase === 'MERGED' || phase === 'CLOSED')) {
        activity.push({ kind: phase === 'MERGED' ? 'merged' : 'closed', jobId: job ?? (pr ? jobByUrl.get(pr.key) ?? null : null), lane: str(row, 'lane', 'pool'), tier: str(row, 'tier'), failed: false, empty: false });
      }
      continue;
    }
    // Unrecognized event kinds are valid ledger rows, just not ours.
  }
  // Rows that do not carry lane/tier (finish tier, publish, outcome) borrow the
  // producing job's latest routing row — resolved post-pass so routes written
  // later in the ledger still attribute.
  for (const a of activity) {
    if (a.lane !== null && a.tier !== null) continue;
    const route = routeOf(a.jobId);
    a.lane ??= route.lane;
    a.tier ??= route.tier;
  }
  return { jobByUrl, jobs, outcomes, activity, counts };
}

// ---------------------------------------------------------------------------
// gh-shaped PR export parse
// ---------------------------------------------------------------------------

export interface GhPullRequest {
  key: string;
  url: string;
  repo: string;
  number: number;
  title: string | null;
  state: string | null;
  mergedAtMs: number | null;
  mergeCommit: string | null;
  files: string[];
  checks: { total: number; failed: number; pending: number; failedNames: string[] } | null;
  commitSubjects: string[];
  body: string | null;
}

const FAILED_CHECK = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED_CHECK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function parseChecks(value: unknown, requiredValue: unknown, head: string | null, mergedAtMs: number | null): GhPullRequest['checks'] {
  // A rollup alone does not identify the required contexts or the commit it
  // describes. Require an explicit, complete list and head-bound observations.
  if (!head || !/^[0-9a-f]{40}$/i.test(head) || !Array.isArray(requiredValue) || requiredValue.length === 0
    || !requiredValue.every((n) => typeof n === 'string' && n.trim() !== '')
    || new Set(requiredValue).size !== requiredValue.length) return null;
  const container = asRow(value);
  const contexts = Array.isArray(value) ? value
    : Array.isArray(container?.['nodes']) ? container['nodes'] as unknown[]
    : Array.isArray(asRow(container?.['contexts'])?.['nodes']) ? asRow(container!['contexts'])!['nodes'] as unknown[]
    : null;
  if (!contexts) return null;
  let failed = 0, pending = 0;
  const failedNames: string[] = [];
  for (const name of requiredValue as string[]) {
    const matches = contexts.map(asRow).filter((c) => c && str(c, 'name', 'context') === name
      && str(c, 'headSha', 'head_sha') === head);
    // Multiple runs may include stale retries; do not guess which was current.
    if (matches.length !== 1) return null;
    const ctx = matches[0]!;
    if (mergedAtMs !== null) {
      const completed = ts(ctx, 'completedAt', 'completed_at');
      if (completed === null || completed > mergedAtMs) return null;
    }
    const conclusion = str(ctx, 'conclusion', 'state')?.toUpperCase() ?? null;
    if (ctx['status'] !== undefined && ctx['status'] !== 'COMPLETED') {
      pending++;
    } else if (conclusion && FAILED_CHECK.has(conclusion)) {
      failed++;
      if (failedNames.length < MAX_FAILED_CHECK_NAMES) failedNames.push(name);
    } else if (!conclusion || !PASSED_CHECK.has(conclusion)) {
      pending++;
    }
  }
  return { total: requiredValue.length, failed, pending, failedNames };
}

function parsePrRow(raw: unknown): GhPullRequest | null {
  const row = asRow(raw);
  if (!row) return null;
  let pr = prUrlOf(row);
  if (!pr) {
    const number = row['number'];
    const repo = asRow(row['repository']) ?? asRow(row['headRepository']);
    const nameWithOwner = repo ? str(repo, 'nameWithOwner', 'name_with_owner') : null;
    if (Number.isSafeInteger(number) && (number as number) > 0 && nameWithOwner && /^[\w.-]+\/[\w.-]+$/.test(nameWithOwner)) {
      pr = prKeyOf(`https://github.com/${nameWithOwner}/pull/${number}`);
    }
  }
  if (!pr) return null;
  const mergeCommitRow = row['mergeCommit'];
  const mergeCommit = typeof mergeCommitRow === 'string' ? mergeCommitRow
    : asRow(mergeCommitRow) ? str(asRow(mergeCommitRow)!, 'oid', 'sha')
    : str(row, 'merge_commit_sha', 'mergeCommitOid');
  const files = (Array.isArray(row['files']) ? row['files'] as unknown[] : []).flatMap((f) => {
    if (typeof f === 'string') return [f];
    const rec = asRow(f);
    const path = rec ? str(rec, 'path', 'filename') : null;
    return path ? [path] : [];
  });
  const commitsContainer = asRow(row['commits']);
  const commitsRaw = Array.isArray(row['commits']) ? row['commits'] as unknown[]
    : Array.isArray(commitsContainer?.['nodes']) ? commitsContainer!['nodes'] as unknown[] : [];
  const commitSubjects: string[] = [];
  for (const c of commitsRaw) {
    const rec = asRow(c);
    const subject = rec ? str(rec, 'messageHeadline', 'message', 'subject') : null;
    if (subject && commitSubjects.length < 50) commitSubjects.push(subject.split('\n')[0]!);
  }
  const state = (str(row, 'state') ?? '').toUpperCase() || null;
  const mergedAtMs = ts(row, 'mergedAt') ?? (state === 'MERGED' ? ts(row, 'closedAt') : null);
  return {
    key: pr.key,
    url: `https://github.com/${pr.repo}/pull/${pr.number}`,
    repo: pr.repo,
    number: pr.number,
    title: str(row, 'title'),
    state,
    mergedAtMs,
    mergeCommit,
    files,
    checks: state === 'MERGED' && mergedAtMs === null ? null : parseChecks(row['statusCheckRollup'] ?? row['statusCheckRollupState'] ?? row['checkSuites'], row['requiredChecks'], str(row, 'headRefOid'), mergedAtMs),
    commitSubjects,
    body: str(row, 'body'),
  };
}

export function parseGhPullRequests(text: string): { rows: GhPullRequest[]; ignored: number } {
  const trimmed = text.trim();
  if (trimmed === '') return { rows: [], ignored: 0 };
  const rows: GhPullRequest[] = [];
  let ignored = 0;
  const push = (value: unknown): void => {
    const row = parsePrRow(value);
    if (row) rows.push(row); else ignored++;
  };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value)) { for (const entry of value) push(entry); return { rows, ignored }; }
    if (asRow(value)) { push(value); return { rows, ignored }; }
  } catch { /* not a single JSON document — try JSONL */ }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    try { push(JSON.parse(line)); } catch { ignored++; }
  }
  return { rows, ignored };
}

// ---------------------------------------------------------------------------
// Durability evidence
// ---------------------------------------------------------------------------

const REVERT_TITLE_RE = /^\s*revert\s+["'“](.+)["'”]\s*$/i;
const REVERT_REF_RE = /\brevert(?:s|ed)?(?:\s+of)?\s+#(\d+)\b/i;
const FOLLOWUP_TITLE_RE = /\b(fix|hotfix|revert|follow[\s-]?up)\b/i;

export type AdverseOutcome = 'reverted' | 'regressed' | 'followed-up';
interface AdverseHit { outcome: AdverseOutcome; confidence: 'deterministic' | 'heuristic'; basis: 'observation-ledger' | 'gh-revert' | 'gh-follow-up' }

function deterministicRevert(p: { number: number; title: string | null }, later: GhPullRequest): boolean {
  if (later.number === p.number) return false;
  if (p.title) {
    const titleRevert = REVERT_TITLE_RE.exec(later.title ?? '');
    if (titleRevert && titleRevert[1]!.trim() === p.title) return true;
    if (later.commitSubjects.some((s) => {
      const m = /^\s*revert\s+["'“](.+)["'”]/i.exec(s);
      return m !== null && m[1]!.trim() === p.title;
    })) return true;
  }
  const ref = REVERT_REF_RE.exec(`${later.title ?? ''}\n${later.body ?? ''}`);
  return ref !== null && Number(ref[1]) === p.number;
}

function overlappingFix(p: GhPullRequest, later: GhPullRequest): boolean {
  if (later.number === p.number || !FOLLOWUP_TITLE_RE.test(later.title ?? '')) return false;
  if (deterministicRevert(p, later)) return false;
  if (p.files.length === 0 || later.files.length === 0) return false;
  const paths = new Set(p.files);
  return later.files.some((f) => paths.has(f));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface CohortEntry {
  pr: EvalPullRequest;
  lane: string;
  tier: string;
  laneTier: string;
  repo: string;
}

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;

function timeStats(values: readonly number[]): { measured: number; median_s: number | null; p90_s: number | null; max_s: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0
    ? { measured: 0, median_s: null, p90_s: null, max_s: null }
    : { measured: sorted.length, median_s: percentile(sorted, 50), p90_s: percentile(sorted, 90), max_s: sorted[sorted.length - 1]! };
}

interface GroupAcc extends EvalGroupRow { _ttm: number[]; _lead: number[] }

function newGroup(name: string): GroupAcc {
  return {
    name, launched: 0, finished: 0, failedFinishes: 0, emptyFinishes: 0, published: 0,
    merged: 0, closed: 0, stable: 0, reverted: 0, regressed: 0, followedUp: 0, pending: 0, unobserved: 0,
    durability: { resolved: 0, rate: null, ci95: null },
    revertRate: null, followUpRate: null,
    ttm: { measured: 0, median_s: null, p90_s: null },
    lead: { measured: 0, median_s: null, p90_s: null },
    checks: { clean: 0, failedChecks: 0, adverseWithClean: 0, adverseWithFailedChecks: 0 },
    _ttm: [], _lead: [],
  };
}

function finishGroup(group: GroupAcc): EvalGroupRow {
  const resolved = group.stable + group.reverted + group.regressed + group.followedUp;
  group.durability = {
    resolved,
    rate: resolved > 0 ? group.stable / resolved : null,
    ci95: wilsonInterval(group.stable, resolved),
  };
  group.revertRate = group.merged > 0 ? group.reverted / group.merged : null;
  group.followUpRate = group.merged > 0 ? (group.regressed + group.followedUp) / group.merged : null;
  const t = timeStats(group._ttm);
  group.ttm = { measured: t.measured, median_s: t.median_s, p90_s: t.p90_s };
  const l = timeStats(group._lead);
  group.lead = { measured: l.measured, median_s: l.median_s, p90_s: l.p90_s };
  const { _ttm, _lead, ...row } = group;
  return row;
}

// ---------------------------------------------------------------------------
// Report build
// ---------------------------------------------------------------------------

export function buildFleetEvalReport(input: FleetEvalReportInput): FleetEvalReport {
  const nowMs = input.nowMs;
  const untilMs = input.untilMs ?? nowMs;
  const windowDays = Math.min(MAX_EVAL_DAYS, Math.max(1, Math.floor(input.windowDays ?? DEFAULT_EVAL_DAYS) || DEFAULT_EVAL_DAYS));
  const sinceMs = untilMs - windowDays * 86_400_000;

  const fold = input.jobsText !== null
    ? foldJobsLedger(input.jobsText, sinceMs, untilMs)
    : { jobByUrl: new Map<string, string>(), jobs: new Map<string, JobFold>(),
        outcomes: new Map<string, OutcomeRow>(), activity: [] as ActivityEvent[],
        counts: { rows: 0, events: 0, ignored: 0 } };

  // --- gh export --------------------------------------------------------------
  const ghRows: GhPullRequest[] = [];
  let ghIgnored = 0;
  for (const text of input.prsTexts ?? []) {
    const parsed = parseGhPullRequests(text);
    ghRows.push(...parsed.rows);
    ghIgnored += parsed.ignored;
  }
  const ghByKey = new Map<string, GhPullRequest>();
  for (const row of ghRows) {
    const prev = ghByKey.get(row.key);
    if (!prev || (row.mergedAtMs ?? -1) > (prev.mergedAtMs ?? -1)) ghByKey.set(row.key, row);
  }
  const ghMerged: GhPullRequest[] = [];
  const ghMergedByRepo = new Map<string, GhPullRequest[]>();
  const ghCoveredRepos = new Set<string>();
  for (const row of ghByKey.values()) {
    ghCoveredRepos.add(row.repo.toLowerCase());
    if (row.state === 'MERGED' || (row.state === null && row.mergedAtMs !== null)) {
      ghMerged.push(row);
      const list = ghMergedByRepo.get(row.repo.toLowerCase()) ?? [];
      list.push(row);
      ghMergedByRepo.set(row.repo.toLowerCase(), list);
    }
  }

  // --- observation ledger -------------------------------------------------------
  const obsByCommit = new Map<string, { outcome: AdverseOutcome; confidence: 'deterministic' | 'heuristic' }>();
  const obsRank = (outcome: AdverseOutcome): number => (outcome === 'reverted' ? 3 : outcome === 'regressed' ? 2 : 1);
  for (const row of input.observations?.rows ?? []) {
    const confidence = row.confidence === 'deterministic' ? 'deterministic' : 'heuristic';
    const prev = obsByCommit.get(row.mergeCommit);
    if (!prev || obsRank(row.outcome) > obsRank(prev.outcome) ||
        (obsRank(row.outcome) === obsRank(prev.outcome) && confidence === 'deterministic' && prev.confidence === 'heuristic')) {
      obsByCommit.set(row.mergeCommit, { outcome: row.outcome, confidence });
    }
  }

  // --- merged cohort ------------------------------------------------------------
  interface MergedPr {
    key: string; url: string; repo: string; number: number;
    mergedAtMs: number | null; ttmLedger: number | null;
    jobId: string | null;
    gh: GhPullRequest | null; mergeCommit: string | null;
    outcomeRepo: string | null;
  }
  const cohort = new Map<string, MergedPr>();
  for (const [url, outcome] of fold.outcomes) {
    if (outcome.state !== 'MERGED' || outcome.atMs === null || outcome.atMs < sinceMs || outcome.atMs >= untilMs) continue;
    const pr = prKeyOf(url);
    const key = pr?.key ?? url;
    const gh = ghByKey.get(key) ?? null;
    cohort.set(key, {
      key, url: gh?.url ?? (pr ? `https://github.com/${pr.repo}/pull/${pr.number}` : url),
      repo: gh?.repo ?? pr?.repo ?? outcome.repo ?? 'unknown',
      number: pr?.number ?? gh?.number ?? 0,
      mergedAtMs: outcome.atMs, ttmLedger: outcome.ttmS,
      jobId: outcome.jobId ?? (pr ? fold.jobByUrl.get(pr.key) ?? null : fold.jobByUrl.get(url) ?? null),
      gh, mergeCommit: outcome.mergeCommit ?? gh?.mergeCommit ?? null,
      outcomeRepo: outcome.repo,
    });
  }
  for (const row of ghMerged) {
    if (row.mergedAtMs === null || row.mergedAtMs < sinceMs || row.mergedAtMs >= untilMs || cohort.has(row.key)) continue;
    cohort.set(row.key, {
      key: row.key, url: row.url, repo: row.repo, number: row.number,
      mergedAtMs: row.mergedAtMs, ttmLedger: null,
      jobId: fold.jobByUrl.get(row.key) ?? null,
      gh: row, mergeCommit: row.mergeCommit, outcomeRepo: null,
    });
  }

  const laterByRepo = (repo: string, mergedAtMs: number, number: number): GhPullRequest[] =>
    (ghMergedByRepo.get(repo.toLowerCase()) ?? []).filter((r) =>
      r.mergedAtMs !== null && (r.mergedAtMs > mergedAtMs || (r.mergedAtMs === mergedAtMs && r.number > number)));

  const entries: CohortEntry[] = [];
  for (const merged of cohort.values()) {
    // Attribution: latest routing row for the job at or before the merge.
    const foldJob = merged.jobId ? fold.jobs.get(merged.jobId) : undefined;
    let route: RoutingRow | null = null;
    if (foldJob && foldJob.routes.length > 0) {
      const sorted = [...foldJob.routes].sort((a, b) => a.atMs - b.atMs);
      route = [...sorted].reverse().find((r) => merged.mergedAtMs === null || r.atMs <= merged.mergedAtMs) ?? sorted[0]!;
    }
    const finish = foldJob && foldJob.finishes.length > 0
      ? [...foldJob.finishes].sort((a, b) => a.atMs - b.atMs)
          .reverse().find((f) => merged.mergedAtMs === null || f.atMs <= merged.mergedAtMs) ?? null
      : null;

    // Durability. The worst evidence across channels wins: a deterministic
    // gh revert still overrides a heuristic ledger follow-up on the same
    // mergeCommit. gh evidence only fires when the export covers the repo.
    let adverse: AdverseHit | null = null;
    const adverseRank = (hit: AdverseHit): number =>
      obsRank(hit.outcome) * 10 + (hit.confidence === 'deterministic' ? 1 : 0);
    const offer = (hit: AdverseHit): AdverseHit =>
      !adverse || adverseRank(hit) > adverseRank(adverse) ? hit : adverse;
    if (merged.mergeCommit) {
      const obs = obsByCommit.get(merged.mergeCommit);
      if (obs) adverse = offer({ outcome: obs.outcome, confidence: obs.confidence, basis: 'observation-ledger' });
    }
    const covered = ghCoveredRepos.has(merged.repo.toLowerCase());
    if (covered && merged.mergedAtMs !== null) {
      const laters = laterByRepo(merged.repo, merged.mergedAtMs, merged.number);
      // A ledger-only merge still earns deterministic revert detection via
      // `Revert #N` references; title-match and follow-up overlap need its row.
      if (laters.some((r) => deterministicRevert({ number: merged.number, title: merged.gh?.title ?? null }, r))) {
        adverse = offer({ outcome: 'reverted', confidence: 'deterministic', basis: 'gh-revert' });
      } else if (merged.gh !== null && laters.some((r) => overlappingFix(merged.gh!, r))) {
        adverse = offer({ outcome: 'followed-up', confidence: 'heuristic', basis: 'gh-follow-up' });
      }
    }
    const windowElapsed = merged.mergedAtMs !== null && nowMs - merged.mergedAtMs >= FLEET_EVAL_OBSERVATION_WINDOW_MS;
    const durability: MergeDurability = adverse ? adverse.outcome
      : !windowElapsed ? 'pending'
      : merged.gh !== null ? 'stable'
      : 'unobserved';

    const checks = merged.gh?.checks ?? null;
    const firstRouteMs = foldJob && foldJob.routes.length > 0
      ? Math.min(...foldJob.routes.map((r) => r.atMs).filter((at) => at > 0))
      : null;
    const derivedLead = merged.mergedAtMs !== null && firstRouteMs !== null && Number.isFinite(firstRouteMs) && merged.mergedAtMs >= firstRouteMs
      ? Math.round((merged.mergedAtMs - firstRouteMs) / 1000)
      : null;
    const ttmLedger = merged.ttmLedger;
    const pr: EvalPullRequest = {
      url: merged.url,
      repo: merged.repo,
      number: merged.number,
      jobId: merged.jobId,
      lane: route?.lane ?? null,
      tier: route?.tier ?? null,
      jobRepo: route?.repo ?? merged.outcomeRepo,
      model: route?.model ?? null,
      mergedAt: merged.mergedAtMs !== null ? new Date(merged.mergedAtMs).toISOString() : null,
      ttm_s: ttmLedger ?? derivedLead,
      ttmSource: ttmLedger !== null ? 'ledger' : derivedLead !== null ? 'derived' : null,
      durability,
      durabilityBasis: adverse?.basis ?? (durability === 'stable' ? 'window' : 'none'),
      durabilityConfidence: adverse?.confidence ?? null,
      checks: checks?.total ?? null,
      failedChecks: checks?.failed ?? null,
      checkState: checks === null || checks.pending > 0 ? 'unknown' : checks.failed > 0 ? 'failed-checks' : 'clean',
      jobFinishFailed: finish ? finish.failed : null,
    };
    entries.push({
      pr,
      lane: route?.lane ?? 'unattributed',
      tier: route?.tier ?? 'unattributed',
      laneTier: `${route?.lane ?? 'unattributed'}:${route?.tier ?? 'unattributed'}`,
      repo: merged.repo,
    });
  }

  // --- groups ---------------------------------------------------------------------
  const adverseOf = (d: MergeDurability): boolean => d === 'reverted' || d === 'regressed' || d === 'followed-up';
  const groups: Record<'lane' | 'tier' | 'laneTier' | 'repo', Map<string, GroupAcc>> = {
    lane: new Map(), tier: new Map(), laneTier: new Map(), repo: new Map(),
  };
  const bump = (dim: keyof typeof groups, name: string): GroupAcc => {
    const map = groups[dim];
    let g = map.get(name);
    if (!g) { g = newGroup(name); map.set(name, g); }
    return g;
  };

  // Windowed activity counters: lane/tier come from the row itself, or from
  // the producing job's latest routing row for publish/outcome rows.
  for (const a of fold.activity) {
    const lane = a.lane ?? 'unattributed';
    const tier = a.tier ?? 'unattributed';
    if (a.kind === 'launch') bump('lane', lane).launched++;
    if (a.kind === 'launch') bump('tier', tier).launched++;
    if (a.kind === 'launch') bump('laneTier', `${lane}:${tier}`).launched++;
    if (a.kind === 'finish') {
      for (const g of [bump('lane', lane), bump('tier', tier), bump('laneTier', `${lane}:${tier}`)]) {
        g.finished++;
        if (a.failed) g.failedFinishes++;
        if (a.empty) g.emptyFinishes++;
      }
    }
    if (a.kind === 'publish') {
      for (const g of [bump('lane', lane), bump('tier', tier), bump('laneTier', `${lane}:${tier}`)]) g.published++;
    }
    if (a.kind === 'closed') {
      for (const g of [bump('lane', lane), bump('tier', tier), bump('laneTier', `${lane}:${tier}`)]) g.closed++;
    }
  }

  // Merged cohort: durability, timing and check evidence per group.
  for (const entry of entries) {
    const { pr } = entry;
    const attributed = pr.jobId !== null;
    for (const dim of ['lane', 'tier', 'laneTier', 'repo'] as const) {
      if (dim !== 'repo' && !attributed) continue;
      const name = dim === 'lane' ? entry.lane : dim === 'tier' ? entry.tier : dim === 'laneTier' ? entry.laneTier : entry.repo;
      const g = bump(dim, name);
      g.merged++;
      if (pr.durability === 'stable') g.stable++;
      else if (pr.durability === 'reverted') g.reverted++;
      else if (pr.durability === 'regressed') g.regressed++;
      else if (pr.durability === 'followed-up') g.followedUp++;
      else if (pr.durability === 'pending') g.pending++;
      else g.unobserved++;
      if (pr.ttm_s !== null && pr.ttmSource === 'ledger') g._ttm.push(pr.ttm_s);
      if (pr.ttm_s !== null) g._lead.push(pr.ttm_s);
      if (pr.checkState === 'clean') { g.checks.clean++; if (adverseOf(pr.durability)) g.checks.adverseWithClean++; }
      else if (pr.checkState === 'failed-checks') { g.checks.failedChecks++; if (adverseOf(pr.durability)) g.checks.adverseWithFailedChecks++; }
    }
  }

  const sortedGroups = (dim: keyof typeof groups): EvalGroupRow[] =>
    [...groups[dim].values()].map(finishGroup).sort((a, b) => a.name.localeCompare(b.name));

  // --- fleet-level rollups ----------------------------------------------------------
  const merges = { total: entries.length, attributed: 0, unattributed: 0, stable: 0, reverted: 0, regressed: 0, followedUp: 0, pending: 0, unobserved: 0 };
  const ttmLedger: number[] = [];
  const lead: number[] = [];
  const ci = {
    measured: 0,
    unknown: 0,
    clean: { merged: 0, adverse: 0 },
    failedChecks: { merged: 0, adverse: 0 },
    jobFinishFailed: { merged: 0, adverse: 0 },
  };
  for (const { pr } of entries) {
    if (pr.jobId) merges.attributed++; else merges.unattributed++;
    if (pr.durability === 'stable') merges.stable++;
    else if (pr.durability === 'reverted') merges.reverted++;
    else if (pr.durability === 'regressed') merges.regressed++;
    else if (pr.durability === 'followed-up') merges.followedUp++;
    else if (pr.durability === 'pending') merges.pending++;
    else merges.unobserved++;
    if (pr.ttm_s !== null && pr.ttmSource === 'ledger') ttmLedger.push(pr.ttm_s);
    if (pr.ttm_s !== null) lead.push(pr.ttm_s);
    if (pr.checkState !== 'unknown') {
      ci.measured++;
      const bucket = pr.checkState === 'clean' ? ci.clean : ci.failedChecks;
      bucket.merged++;
      if (adverseOf(pr.durability)) bucket.adverse++;
    } else ci.unknown++;
    if (pr.jobFinishFailed === true) {
      ci.jobFinishFailed.merged++;
      if (adverseOf(pr.durability)) ci.jobFinishFailed.adverse++;
    }
  }
  const jobsCounts = { launched: 0, finished: 0, failedFinishes: 0, emptyFinishes: 0, published: 0, merged: 0, closed: 0 };
  for (const a of fold.activity) {
    if (a.kind === 'launch') jobsCounts.launched++;
    else if (a.kind === 'finish') { jobsCounts.finished++; if (a.failed) jobsCounts.failedFinishes++; if (a.empty) jobsCounts.emptyFinishes++; }
    else if (a.kind === 'publish') jobsCounts.published++;
    else if (a.kind === 'merged') jobsCounts.merged++;
    else if (a.kind === 'closed') jobsCounts.closed++;
  }

  const resolved = merges.stable + merges.reverted + merges.regressed + merges.followedUp;
  const rate = (a: number, n: number): number | null => (n > 0 ? a / n : null);
  const direction: FleetEvalReport['ci']['direction'] =
    ci.clean.merged === 0 || ci.failedChecks.merged === 0 ? 'insufficient-data'
    : ci.failedChecks.adverse / ci.failedChecks.merged > ci.clean.adverse / ci.clean.merged ? 'failed-checks-more-adverse'
    : ci.failedChecks.adverse / ci.failedChecks.merged < ci.clean.adverse / ci.clean.merged ? 'clean-more-adverse'
    : 'even';

  const ranked = (['lane', 'tier', 'laneTier', 'repo'] as const).flatMap((dim) =>
    sortedGroups(dim)
      .filter((g) => g.durability.resolved > 0)
      .map((g) => ({
        kind: (dim === 'laneTier' ? 'lane+tier' : dim) as 'lane' | 'tier' | 'lane+tier' | 'repo',
        name: g.name,
        resolved: g.durability.resolved,
        durabilityRate: g.durability.rate!,
        lowerBound: g.durability.ci95?.[0] ?? g.durability.rate!,
      })))
    .sort((a, b) => b.lowerBound - a.lowerBound || b.resolved - a.resolved || a.name.localeCompare(b.name));

  const jobsSource = input.jobsText === null ? 'missing'
    : fold.counts.ignored > 0 ? 'degraded' : 'healthy';
  const prsState = (input.prsTexts ?? []).length === 0 ? 'absent'
    : ghIgnored > 0 ? 'degraded' : 'healthy';
  const obsSource = input.observations == null ? 'disabled' : input.observations.sourceState;

  return {
    schema: FLEET_EVAL_REPORT_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    window: {
      days: windowDays,
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
    },
    sources: {
      jobs: { state: jobsSource, rows: fold.counts.rows, events: fold.counts.events, ignored: fold.counts.ignored },
      pullRequests: {
        state: prsState, files: (input.prsTexts ?? []).length,
        rows: ghRows.length, mergedRows: ghMerged.length, ignored: ghIgnored,
      },
      observations: { state: obsSource, rows: input.observations?.rows.length ?? 0 },
    },
    jobs: jobsCounts,
    merges: {
      ...merges,
      resolved,
      fleetIQ: resolved > 0 ? Math.round((merges.stable / resolved) * 1000) / 10 : null,
      fleetIqCi95: wilsonInterval(merges.stable, resolved),
    },
    timeToMerge: timeStats(ttmLedger),
    mergeLead: timeStats(lead),
    ci: {
      measured: ci.measured,
      unknown: ci.unknown,
      clean: { ...ci.clean, adverseRate: rate(ci.clean.adverse, ci.clean.merged) },
      failedChecks: { ...ci.failedChecks, adverseRate: rate(ci.failedChecks.adverse, ci.failedChecks.merged) },
      jobFinishFailed: { ...ci.jobFinishFailed, adverseRate: rate(ci.jobFinishFailed.adverse, ci.jobFinishFailed.merged) },
      direction,
    },
    byLane: sortedGroups('lane'),
    byTier: sortedGroups('tier'),
    byLaneTier: sortedGroups('laneTier'),
    byRepo: sortedGroups('repo'),
    ranked,
    pullRequests: entries.map((e) => e.pr).sort((a, b) => a.url.localeCompare(b.url)),
  };
}

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

const pct = (value: number | null): string => (value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`);

export function formatFleetEvalReport(report: FleetEvalReport): string {
  const lines: string[] = [];
  const m = report.merges;
  lines.push(`Fleet IQ (${report.window.days}d, ${report.window.since.slice(0, 10)} → ${report.window.until.slice(0, 10)}): ` +
    (m.fleetIQ === null ? 'unknown — no resolved merges' : `${m.fleetIQ} durable (${m.stable} stable / ${m.resolved} resolved)`));
  lines.push(`Merged PRs: ${m.total} (${m.attributed} fleet-attributed, ${m.unattributed} unattributed) — ` +
    `${m.reverted} reverted, ${m.regressed} regressed, ${m.followedUp} followed-up, ${m.pending} pending, ${m.unobserved} unobserved`);
  lines.push(`Time to merge: ${report.timeToMerge.measured ? `median ${report.timeToMerge.median_s}s, p90 ${report.timeToMerge.p90_s}s (${report.timeToMerge.measured} measured)` : 'no ledger ttm samples'}; ` +
    `merge lead: ${report.mergeLead.measured ? `median ${report.mergeLead.median_s}s, p90 ${report.mergeLead.p90_s}s` : 'unmeasured'}`);
  const ci = report.ci;
  lines.push(`CI correlation: ${ci.measured ? `clean ${pct(ci.clean.adverseRate)} adverse (${ci.clean.merged}), failed-checks ${pct(ci.failedChecks.adverseRate)} adverse (${ci.failedChecks.merged}) — ${ci.direction}` : 'no check data'}; unknown ${ci.unknown}; ` +
    `job-finish-failed ${pct(ci.jobFinishFailed.adverseRate)} adverse (${ci.jobFinishFailed.merged})`);
  for (const [label, rows] of [['By lane', report.byLane], ['By tier', report.byTier]] as const) {
    if (rows.length === 0) continue;
    lines.push(label + ':');
    for (const g of rows) {
      lines.push(`  ${g.name}: ${g.merged} merged, ${pct(g.durability.rate)} durable (${g.durability.resolved} resolved), ` +
        `${g.reverted} reverted, ${g.regressed + g.followedUp} follow-up/regressed` +
        (g.ttm.measured ? `, ttm median ${g.ttm.median_s}s` : ''));
    }
  }
  if (report.ranked.length > 0) {
    lines.push('Most durable (Wilson lower bound): ' +
      report.ranked.slice(0, 5).map((r) => `${r.name} ${pct(r.durabilityRate)} n=${r.resolved}`).join(', '));
  }
  lines.push(`Sources: jobs ${report.sources.jobs.state}, gh export ${report.sources.pullRequests.state}, observations ${report.sources.observations.state}`);
  return lines.join('\n');
}
