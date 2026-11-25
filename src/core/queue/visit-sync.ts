/**
 * visit-sync.ts — producer for the queue visit journal (journal.ts), which
 * `phm queue stats` and `GET /api/queue/stats` read but fleet events never
 * wrote. Folds `metrics/jobs.jsonl` (per-attempt lifecycle; `launch` rows
 * delimit attempts), the live `- READY` rows of `queue/router-queue.md`, and
 * the sampled check observations of `metrics/merge-events.jsonl` into
 * `QueueVisit` snapshots. Station mapping and honesty rules:
 * docs/QUEUE-STATS.md. Derived timestamps only — missing boundaries leave a
 * visit open or absent, never zero-filled; rows after `now` are ignored.
 *
 * The jobs ledger's `ci_start`/`ci_complete` boundary events have no
 * producer, so the pr-ci service start and the merge-queue entry boundary
 * are derived from the merge-queue loop's recorded check observations
 * instead: a publish row's URL joins its PR's timed `check_observed` /
 * `checks_passed` rows, the last recorded green inside the attempt's
 * terminal bound is the CI-complete boundary, and the first pending
 * observation of that final run is the service start. Ledger ci rows always
 * win; unsampled phases report as wait, never guessed.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseLedgerTs } from '../metrics/loop.js';
import {
  readLedgerFile, readLedgerTail, ROUTER_MERGE_EVENTS_LEDGER_RELATIVE,
  ROUTER_OUTCOME_LEDGER_RELATIVE,
  type LedgerReadState, type LedgerTailRead,
} from '../router/outcomes.js';
import { appendQueueVisits, compactQueueVisits, queueJournalPath, readQueueVisits } from './journal.js';
import { isQueueVisit, queueVisitKey, type QueueVisit } from './stats.js';

export const VISIT_SYNC_SCHEMA = 'queue.visits-sync.v1';

/** Bounded read of router-queue.md behind live READY visits; past it READY visits are skipped, never guessed. */
export const VISIT_SYNC_QUEUE_BYTES = 4 * 1024 * 1024;

const STATION_READY = 'READY';
const STATION_CLAIMED = 'claimed';
const STATION_PUBLISH = 'publish';
const STATION_PR_CI = 'pr-ci';
const STATION_MERGE_QUEUE = 'merge-queue';
const STATION_MERGED = 'merged';

type VisitKind =
  | 'enqueue' | 'queued' | 'launch' | 'finish' | 'publish'
  | 'merged' | 'closed' | 'noop' | 'launch_failed' | 'ci_start' | 'ci_complete';

interface LedgerEvent {
  job: string;
  kind: VisitKind;
  /** ms epoch from the row's own timestamp fields. */
  at: number;
  /** File order; the ledger is append-only so order is causal. */
  order: number;
  url: string | null;
  lane: string | null;
  /** `launch_failed` receipts carry action=retry|give_up. */
  action: string | null;
  /** DONE-NOOP rows record launched=false when the job never ran. */
  launchedFalse: boolean;
}

const KNOWN_EVENTS = new Set<string>([
  'enqueue', 'queued', 'launch', 'finish', 'publish', 'launch_failed', 'ci_start', 'ci_complete',
]);

/** A github.com pull URL in the canonical shape dispatchd and the fleet writers emit. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/([1-9]\d*)\/?$/i;

/** `owner/repo#n` (lowercase repo) for a pull URL; null when the URL is not that shape. */
function pullRequestKey(url: string): string | null {
  const m = GITHUB_PULL_URL.exec(url);
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}#${m[3]}` : null;
}

export type MergeCheckConclusion = 'pending' | 'failure' | 'success';

/**
 * One timed check observation from metrics/merge-events.jsonl — the
 * merge-queue loop's sampled head-rollup verdicts (`check_observed` rows)
 * plus its once-per-PR `checks_passed` boundary, both normalized onto the
 * rollup conclusion vocabulary. `at` is the sampler's observation instant
 * in ms, never an exact GitHub transition time.
 */
export interface MergeCheckObservation {
  at: number;
  /** File order within the retained merge-events tail; ties break by it. */
  order: number;
  conclusion: MergeCheckConclusion;
}

const MERGE_EVENT_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * Fold merge-events.jsonl text into per-PR timed check observations keyed
 * `owner/repo#n` (lowercase repo — the same key pullRequestKey produces, so
 * a publish row's URL joins without a second canonicalization). Only the
 * two check-bearing row types count: `check_observed` needs its recorded
 * in-vocabulary conclusion (and a boolean `required` when the row carries
 * one), `checks_passed` reads as a `success` observation. Every other event
 * type, unparseable `at`, malformed repo/pr and near-miss rows are skipped,
 * never guessed — the same validation bar foldMergeEvents applies. Each
 * PR's rows are sorted by (at, order): the ledger's append order is causal
 * but sampled stamps can tie or drift, so the sort keeps boundary scans
 * deterministic.
 */
export function foldMergeEventChecks(text: string | null): Map<string, MergeCheckObservation[]> {
  const prs = new Map<string, MergeCheckObservation[]>();
  if (text === null) return prs;
  let order = 0;
  for (const line of text.split('\n')) {
    const lineOrder = order++;
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const repo = row['repo'];
    const pr = row['pr'];
    const type = row['type'];
    if (typeof repo !== 'string' || !MERGE_EVENT_REPO.test(repo) ||
        typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1 ||
        (type !== 'check_observed' && type !== 'checks_passed')) continue;
    let conclusion: MergeCheckConclusion;
    if (type === 'check_observed') {
      const c = row['conclusion'];
      if (c !== 'success' && c !== 'failure' && c !== 'pending') continue;
      const req = row['required'];
      if (req !== undefined && typeof req !== 'boolean') continue;
      conclusion = c;
    } else {
      conclusion = 'success';
    }
    const at = parseLedgerTs(row['at']);
    if (at === null) continue;
    const key = `${repo.toLowerCase()}#${pr}`;
    const list = prs.get(key) ?? [];
    list.push({ at, order: lineOrder, conclusion });
    prs.set(key, list);
  }
  for (const list of prs.values()) list.sort((a, b) => a.at - b.at || a.order - b.order);
  return prs;
}

export interface DerivedCiBoundaries {
  /** First observed pending stamp of the final green run; null when sampling never saw it. */
  start: number | null;
  /** Last recorded green observation inside the attempt's evidence window. */
  complete: number | null;
}

/**
 * Derive one attempt's CI service window from its PR's sampled
 * merge-events check observations. `complete` is the LAST recorded green
 * observation inside [publishAt, boundAt] — the most recent merge-ready
 * boundary before the attempt's terminal, so merge-queue dwell measures
 * from the head that actually entered the queue rather than the first
 * green of an earlier head. `start` is the first `pending` observation of
 * the final green run — the pending rows after the last concluded row
 * (a failure or an earlier green episode) before the trailing all-success
 * run; consecutive greens collapse into one episode because checks_passed
 * restates the check_observed success it accompanies. A run whose pending
 * phase sampling missed leaves start null so the dwell reports as wait,
 * never guessed. No green observation means no complete boundary: the
 * stations stay absent exactly like a ledger without ci_complete rows.
 */
function deriveCiBoundaries(
  rows: readonly MergeCheckObservation[] | undefined,
  publishAt: number,
  boundAt: number,
): DerivedCiBoundaries {
  const window = (rows ?? []).filter(r => r.at >= publishAt && r.at <= boundAt);
  let greenEnd = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i]!.conclusion === 'success') { greenEnd = i; break; }
  }
  if (greenEnd < 0) return { start: null, complete: null };
  let greenStart = greenEnd;
  while (greenStart > 0 && window[greenStart - 1]!.conclusion === 'success') greenStart--;
  let bound = -1;
  for (let i = greenStart - 1; i >= 0; i--) {
    if (window[i]!.conclusion !== 'pending') { bound = i; break; }
  }
  const start = bound + 1 < greenStart ? window[bound + 1]!.at : null;
  return { start, complete: window[greenEnd]!.at };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stateOf(row: Record<string, unknown>): string {
  return String(row.outcome ?? row.state ?? row.status ?? row.phase ?? row.result ?? row.conclusion ?? '').toUpperCase();
}

const TS_FIELDS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;

/** First parseable timestamp among the ledger's field variants; MERGED prefers mergedAt, CLOSED closedAt. */
function eventTs(row: Record<string, unknown>, state: string): number | null {
  const preferred = state === 'MERGED' ? 'mergedAt' : state === 'CLOSED' ? 'closedAt' : null;
  const fields = preferred ? [preferred, ...TS_FIELDS.filter(f => f !== preferred)] : [...TS_FIELDS];
  for (const field of fields) {
    const at = parseLedgerTs(row[field]);
    if (at !== null) return at;
  }
  return null;
}

function urlOf(row: Record<string, unknown>): string | null {
  for (const key of ['url', 'prUrl', 'pr_url', 'pr', 'html_url'] as const) {
    const value = str(row[key]);
    if (value) return value.replace(/\/+$/, '');
  }
  return null;
}

/** Classify one jobs.jsonl row into a visit-relevant event, or null when it is not one.
 * Mirrors dispatchd's _vc_event/_vc_phase: event|type|kind fields, 'published'
 * normalizes to publish, and eventless phase rows infer their kind. */
function classifyRow(row: Record<string, unknown>, order: number, now: number): Omit<LedgerEvent, 'job'> | null {
  let event = str(row.event ?? row.type ?? row.kind);
  if (event === 'published') event = 'publish';
  const state = stateOf(row);
  let kind: VisitKind | null = null;
  if (event !== null && KNOWN_EVENTS.has(event)) {
    kind = event as VisitKind;
  } else if (event === null || event === 'outcome') {
    if (state === 'MERGED') kind = 'merged';
    else if (state === 'CLOSED') kind = 'closed';
    else if (state === 'DONE-NOOP') kind = 'noop';
    else if (state === 'PUBLISHED') kind = 'publish';
  }
  if (!kind) return null;
  const at = eventTs(row, state);
  if (at === null || at > now) return null;
  return {
    kind, at, order,
    url: urlOf(row),
    lane: str(row.lane ?? row.pool ?? row.arm),
    action: str(row.action),
    launchedFalse: row.launched === false,
  };
}

const visitId = (job: string, attempt: number): string => `${job}:a${attempt}`;

function makeVisit(job: string, attempt: number, station: string, pool: string,
  arrivedAt: number, startedAt?: number, completedAt?: number): QueueVisit | null {
  const visit: QueueVisit = { id: visitId(job, attempt), station, pool, arrivedAt };
  if (startedAt !== undefined) visit.startedAt = startedAt;
  if (completedAt !== undefined) visit.completedAt = completedAt;
  return isQueueVisit(visit) ? visit : null;
}

/** Earliest event of the given kinds by (at, order); ties keep file order. */
function earliest(events: readonly LedgerEvent[], kinds: readonly VisitKind[]): LedgerEvent | null {
  let best: LedgerEvent | null = null;
  for (const e of events) {
    if (!kinds.includes(e.kind)) continue;
    if (!best || e.at < best.at || (e.at === best.at && e.order < best.order)) best = e;
  }
  return best;
}

function poolOf(...lanes: Array<string | null>): string {
  for (const lane of lanes) if (lane) return lane;
  return 'unknown';
}

interface AttemptTerminal { merged: LedgerEvent | null; closed: LedgerEvent | null }

/**
 * Fold one job's ordered events into station visits. `events` must already be
 * filtered to visit-relevant kinds with `at <= now`, in file order.
 * `ciEvidence` carries the merge-events check observations keyed by canonical
 * PR (`owner/repo#n`); a ledger `ci_start`/`ci_complete` row always wins over
 * the derived boundary, which itself only fills what sampling recorded.
 */
function visitsForJob(
  job: string,
  events: LedgerEvent[],
  now: number,
  ciEvidence?: ReadonlyMap<string, readonly MergeCheckObservation[]>,
): { visits: QueueVisit[]; invalid: number } {
  const visits: QueueVisit[] = [];
  let invalid = 0;
  const push = (v: QueueVisit | null) => { if (v) visits.push(v); else invalid++; };
  const ordered = [...events].sort((a, b) => a.order - b.order);
  const launches = ordered.filter(e => e.kind === 'launch');
  const enqueue = earliest(ordered, ['enqueue', 'queued']);
  const noop = ordered.find(e => e.kind === 'noop' && e.launchedFalse) ?? null;

  if (launches.length === 0) {
    // Resolved while queued: the only fully-evidenced READY dwell without a launch.
    if (enqueue && noop && noop.at >= enqueue.at) {
      push(makeVisit(job, 1, STATION_READY, poolOf(enqueue.lane), enqueue.at, noop.at, noop.at));
    }
    return { visits, invalid };
  }

  // Attempt k owns (launch_k.order, launch_{k+1}.order); the same span is the
  // next attempt's queue gap, so launch_failed retries inside it are arrival
  // evidence for attempt k+1.
  const windows = launches.map((launch, k) => {
    const next = launches[k + 1];
    return ordered.filter(e => e.order > launch.order && (next === undefined || e.order < next.order));
  });
  const preQueue = ordered.filter(e => e.order < launches[0]!.order);

  // Publish URLs map globally: late outcomes match the PR, not the job id or
  // the window they happen to land in (dispatchd reconciliation contract).
  const urlToAttempt = new Map<string, number>();
  launches.forEach((_, k) => {
    for (const e of windows[k]!) {
      if (e.kind === 'publish' && e.url && !urlToAttempt.has(e.url)) urlToAttempt.set(e.url, k);
    }
  });
  const terminals = ordered.filter(e => e.kind === 'merged' || e.kind === 'closed');
  const terminalFor = (k: number): AttemptTerminal => {
    const merged: LedgerEvent[] = [];
    const closed: LedgerEvent[] = [];
    for (const t of terminals) {
      if (t.order <= launches[k]!.order) continue;
      let owner = -1;
      if (t.url !== null && urlToAttempt.has(t.url)) owner = urlToAttempt.get(t.url)!;
      else if (launches.length === 1) owner = 0;
      else if (t.url === null) owner = launches.length - 1; // dispatchd: url-less outcomes hit the current attempt
      else owner = windows.findIndex(w => w.includes(t));
      if (owner === k) (t.kind === 'merged' ? merged : closed).push(t);
    }
    return { merged: earliest(merged, ['merged']), closed: earliest(closed, ['closed']) };
  };

  launches.forEach((launch, k) => {
    const attempt = k + 1;
    const win = windows[k]!;
    const pool = poolOf(launch.lane, enqueue?.lane ?? null);
    const { merged, closed } = terminalFor(k);
    const exits = [merged, closed].filter((e): e is LedgerEvent => e !== null)
      .sort((a, b) => a.at - b.at || a.order - b.order);

    // READY: queue dwell ends when the launch fires; dispatch service is
    // instantaneous, so startedAt === completedAt keeps wait honest and mu null.
    const arrivalPool = k === 0
      ? preQueue.filter(e => e.kind === 'enqueue' || e.kind === 'queued' || (e.kind === 'launch_failed' && e.action === 'retry'))
      : windows[k - 1]!.filter(e => e.kind === 'launch_failed' && e.action === 'retry');
    const arrival = earliest(arrivalPool, ['enqueue', 'queued', 'launch_failed'])?.at ?? null;
    if (arrival !== null) {
      push(makeVisit(job, attempt, STATION_READY, pool, arrival, launch.at, launch.at));
    }

    // claimed: dedicated worker — service starts at launch; exit is the first
    // recorded boundary (finish, publish or a matched terminal outcome).
    const claimedExit = earliest(
      [...win.filter(e => e.kind === 'finish' || e.kind === 'publish'), ...exits],
      ['finish', 'publish', 'merged', 'closed']);
    push(makeVisit(job, attempt, STATION_CLAIMED, pool, launch.at, launch.at, claimedExit?.at));

    // publish: entry is the finish row; exit is the publish row. A finish
    // without publish stays an open visit — the publisher slot is genuinely pending.
    const finish = earliest(win, ['finish']);
    const publish = earliest(win, ['publish']);
    if (finish) {
      push(makeVisit(job, attempt, STATION_PUBLISH, pool, finish.at,
        publish && publish.at >= finish.at ? publish.at : undefined, publish?.at));
    }

    // The attempt's CI evidence window ends at its first matched terminal
    // (or now while unresolved): check observations past that bound belong
    // to a later life of the PR, never this attempt's CI phase.
    const ciBoundAt = exits.length > 0 ? exits[0]!.at : now;
    const prKey = publish !== null && publish.url !== null ? pullRequestKey(publish.url) : null;
    const derivedCi = prKey !== null
      ? deriveCiBoundaries(ciEvidence?.get(prKey), publish!.at, ciBoundAt)
      : { start: null, complete: null };

    // pr-ci: entry is the PR opening; ci_start is the service start when the
    // ledger carries it, the merge-events-derived pending stamp when only
    // sampling saw the run, otherwise the whole dwell reports as wait. The
    // derived green boundary stands in for ci_complete only when the ledger
    // recorded none — a real row always wins, matching merge-queue below.
    if (publish) {
      const after = win.filter(e => e.order > publish.order);
      const ciStart = earliest(after, ['ci_start']);
      const ledgerCiAts = after.filter(e => e.kind === 'ci_complete').map(e => e.at);
      const exitAts = [...ledgerCiAts];
      for (const e of exits) if (e.order > publish.order) exitAts.push(e.at);
      if (ledgerCiAts.length === 0 && derivedCi.complete !== null) exitAts.push(derivedCi.complete);
      const exitAt = exitAts.length > 0 ? Math.min(...exitAts) : undefined;
      const ciStartAt = ciStart?.at ?? derivedCi.start;
      const started = ciStartAt !== null && (exitAt === undefined || ciStartAt <= exitAt) ? ciStartAt : exitAt;
      push(makeVisit(job, attempt, STATION_PR_CI, pool, publish.at, started, exitAt));
    }

    // merge-queue: entry needs a ci_complete boundary — the ledger's own
    // event, or the last recorded green check observation the merge-events
    // fold derives; exit is merge or a matched terminal. Missing boundary
    // stays absent rather than guessed.
    const ciComplete = earliest(win, ['ci_complete']);
    const ciCompleteAt = ciComplete !== null ? ciComplete.at : derivedCi.complete;
    if (ciCompleteAt !== null) {
      const exit = ciComplete !== null
        ? exits.find(e => e.order > ciComplete.order) ?? null
        : exits.find(e => e.at >= ciCompleteAt) ?? null;
      push(makeVisit(job, attempt, STATION_MERGE_QUEUE, pool, ciCompleteAt, exit?.at, exit?.at));
    }

    // merged: terminal marker carrying merge throughput as a zero-dwell visit.
    if (merged) {
      push(makeVisit(job, attempt, STATION_MERGED, pool, merged.at, merged.at, merged.at));
    }
  });

  return { visits, invalid };
}

export interface JobQueueEvidence {
  enqueueAt: number | null;
  lane: string | null;
  launches: number;
}

export interface JobsVisitFold {
  visits: QueueVisit[];
  /** Per-job queue evidence for the live READY overlay. */
  jobs: Map<string, JobQueueEvidence>;
  rows: number;
  ignored: number;
  invalid: number;
}

/**
 * Fold jobs.jsonl text into station visits plus per-job queue evidence.
 * Rows are grouped by job id in file order; attempts split on `launch`.
 * `ciEvidence` is the optional merge-events check-observation fold
 * (`foldMergeEventChecks`); without it the pr-ci and merge-queue stations
 * behave exactly as before — ledger ci boundaries only, derived ones absent.
 */
export function queueVisitsFromJobs(
  text: string | null,
  now = Date.now(),
  ciEvidence?: ReadonlyMap<string, readonly MergeCheckObservation[]>,
): JobsVisitFold {
  const byJob = new Map<string, LedgerEvent[]>();
  const jobs = new Map<string, JobQueueEvidence>();
  let rows = 0, ignored = 0, invalid = 0;
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows++;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { ignored++; continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { ignored++; continue; }
    const row = raw as Record<string, unknown>;
    const id = str(row.job ?? row.job_id ?? row.jobId ?? row.id);
    const classified = id ? classifyRow(row, rows - 1, now) : null;
    if (!id || !classified) { ignored++; continue; }
    const ev: LedgerEvent = { ...classified, job: id };
    const list = byJob.get(id) ?? [];
    list.push(ev);
    byJob.set(id, list);
    const info = jobs.get(id) ?? { enqueueAt: null, lane: null, launches: 0 };
    if ((ev.kind === 'enqueue' || ev.kind === 'queued') && (info.enqueueAt === null || ev.at < info.enqueueAt)) {
      info.enqueueAt = ev.at;
      info.lane = ev.lane ?? info.lane;
    }
    if (ev.kind === 'launch') info.launches++;
    jobs.set(id, info);
  }
  const visits: QueueVisit[] = [];
  for (const [job, events] of byJob) {
    const fold = visitsForJob(job, events, now, ciEvidence);
    visits.push(...fold.visits);
    invalid += fold.invalid;
  }
  return { visits, jobs, rows, ignored, invalid };
}

/**
 * Open READY visits for jobs still listed `- READY` in router-queue.md.
 * Arrival is the ledger enqueue stamp when known, else the line's `enq=`
 * epoch-seconds token; neither means the wait cannot be bounded, so the job
 * is skipped rather than stamped at an invented time. Only first-stint jobs
 * (zero launches) qualify — a re-queued attempt has no recorded re-arrival.
 */
export function queueReadyVisits(
  queueText: string,
  jobs: ReadonlyMap<string, JobQueueEvidence>,
  now: number,
): QueueVisit[] {
  const visits: QueueVisit[] = [];
  for (const line of queueText.split(/\r?\n/)) {
    const match = /^- READY\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(line);
    if (!match) continue;
    const id = match[1]!;
    const info = jobs.get(id);
    if (info && info.launches > 0) continue;
    const enq = /(?:^|[\s,(])enq=(\d+)(?=$|[\s,)])/.exec(line);
    const arrivedAt = info?.enqueueAt ?? (enq ? Number(enq[1]) * 1000 : null);
    if (arrivedAt === null || !Number.isFinite(arrivedAt) || arrivedAt > now) continue;
    const visit = makeVisit(id, 1, STATION_READY, poolOf(info?.lane ?? null), arrivedAt);
    if (visit) visits.push(visit);
  }
  return visits;
}

function completeness(visit: QueueVisit): number {
  return (visit.startedAt === undefined ? 0 : 1) + (visit.completedAt === undefined ? 0 : 1);
}

function sameVisit(a: QueueVisit, b: QueueVisit): boolean {
  return a.id === b.id && a.station === b.station && a.pool === b.pool &&
    a.arrivedAt === b.arrivedAt && a.startedAt === b.startedAt && a.completedAt === b.completedAt;
}

export interface VisitSyncPlan {
  append: QueueVisit[];
  unchanged: number;
  /** Candidates less complete than the journal's latest snapshot; never appended. */
  regression: number;
}

/**
 * Diff derived visits against the journal's latest snapshot per
 * (station, pool, id) — the same dedup key estimateQueueStats uses. Snapshots
 * only gain fields over time, so a candidate appends when it is new, more
 * complete, or different at equal completeness; a less complete candidate is
 * a regression and is refused.
 */
export function planVisitSync(visits: readonly QueueVisit[], existing: readonly QueueVisit[]): VisitSyncPlan {
  const latest = new Map<string, QueueVisit>();
  for (const v of existing) {
    if (!isQueueVisit(v)) continue;
    latest.set(queueVisitKey(v), v);
  }
  const plan: VisitSyncPlan = { append: [], unchanged: 0, regression: 0 };
  for (const candidate of visits) {
    if (!isQueueVisit(candidate)) continue;
    const key = queueVisitKey(candidate);
    const prior = latest.get(key);
    if (!prior) { plan.append.push(candidate); continue; }
    if (completeness(candidate) < completeness(prior)) { plan.regression++; continue; }
    if (sameVisit(candidate, prior)) { plan.unchanged++; continue; }
    plan.append.push(candidate);
  }
  return plan;
}

export interface QueueVisitSyncOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as reward-feed). */
  runsDir?: string;
  /** Injected jobs-ledger tail text; skips the jobs.jsonl read when set. */
  jobsText?: string;
  /** Injected router-queue.md text; undefined reads the file, null means missing. */
  queueText?: string | null;
  /**
   * Injected merge-events.jsonl tail text; undefined reads
   * <runsDir>/metrics/merge-events.jsonl, null means missing. Its check
   * observations derive the pr-ci service start and the merge-queue entry
   * boundary the jobs ledger's ci_start/ci_complete rows never record.
   */
  mergeEventsText?: string | null;
  /** Visit journal path; defaults to queueJournalPath() (~/.ashlr/queue/visits.jsonl). */
  journalPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export interface QueueVisitSyncResult {
  /** Health of the jobs-ledger tail; only 'read' can fold visits. */
  state: LedgerReadState | 'error';
  jobsPath: string;
  queuePath: string;
  journalPath: string;
  /** True when the jobs tail dropped older bytes — early lifecycle events of older jobs may be missing. */
  truncated: boolean;
  /** Health of the router-queue.md read behind live READY visits; 'not-read' when the pass never reached it. */
  queueState: LedgerReadState | 'not-read';
  /**
   * Health of the visit-journal read behind the dedup plan; 'not-read' when
   * the pass never reached it. 'read' covers a missing or empty journal —
   * both load as an empty dedup set, which is safe to append against.
   */
  journalState: 'read' | 'unreadable' | 'not-read';
  /** jobs.jsonl rows scanned this pass. */
  rows: number;
  ignored: number;
  invalid: number;
  /**
   * Health of the merge-events.jsonl tail behind the derived CI
   * boundaries; 'not-read' when the pass never reached it. A non-'read'
   * state leaves every derived boundary absent — the fold still runs on
   * ledger ci_start/ci_complete rows alone, exactly as before.
   */
  mergeEventsState: LedgerReadState | 'not-read';
  /** True when the merge-events tail dropped older bytes — early check observations may be missing. */
  mergeEventsTruncated: boolean;
  /** Station visits derived (ledger fold plus live READY rows) before dedup. */
  derived: number;
  /** Snapshots appended to the journal this pass. */
  appended: number;
  unchanged: number;
  /** Candidates less complete than the journal's latest snapshot; refused, never appended. */
  regression: number;
  /** True when this pass rewrote the journal under its byte cap (journal.ts compaction). */
  journalCompacted: boolean;
  /** Snapshot lines the compaction removed; 0 when no rewrite ran. */
  journalDropped: number;
}

function visitSyncBase(
  state: QueueVisitSyncResult['state'], jobsPath: string, queuePath: string, journalPath: string,
): QueueVisitSyncResult {
  return {
    state, jobsPath, queuePath, journalPath, truncated: false,
    queueState: 'not-read', journalState: 'not-read',
    rows: 0, ignored: 0, invalid: 0, derived: 0, appended: 0, unchanged: 0, regression: 0,
    mergeEventsState: 'not-read', mergeEventsTruncated: false,
    journalCompacted: false, journalDropped: 0,
  };
}

async function queueTextOrInjected(
  injected: string | null | undefined, queuePath: string,
): Promise<{ state: LedgerReadState; text: string | null }> {
  if (injected !== undefined) {
    return injected === null
      ? { state: 'missing', text: null }
      : { state: 'read', text: injected };
  }
  const read = await readLedgerFile(queuePath, VISIT_SYNC_QUEUE_BYTES);
  return { state: read.state, text: read.state === 'read' ? read.text : null };
}

/**
 * Refresh the queue visit journal from the fleet jobs ledger and the live
 * router queue — the same fold `phm queue visits-sync --apply` runs, on the
 * daemon's self-improvement cadence so `phm queue stats` and
 * GET /api/queue/stats stay fed without a manual pass. Safe to call any
 * time. Never throws: ledger problems come back as `state`, journal read
 * problems skip the append as `journalState: 'unreadable'` (an unreadable
 * dedup set must never be appended against), write problems as
 * `state: 'error'`.
 *
 * Bounded like the sibling syncs: the jobs ledger contributes its newest
 * ROUTER_OUTCOME_LEDGER_LIMIT bytes (`truncated` reports the cut) and
 * router-queue.md at most VISIT_SYNC_QUEUE_BYTES. A cut jobs tail can leave
 * a job's early events out of this pass's fold; planVisitSync's
 * completeness rule refuses any candidate less complete than the journal's
 * latest snapshot, and a later pass with the events back in view appends the
 * fuller snapshot as a progression — missing boundaries stay absent in the
 * meantime, never zero-filled.
 */
export async function syncQueueVisits(opts: QueueVisitSyncOptions = {}): Promise<QueueVisitSyncResult> {
  const now = opts.now ?? Date.now;
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const jobsPath = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
  const queuePath = join(runsDir, 'queue', 'router-queue.md');
  const journalPath = opts.journalPath ?? queueJournalPath();
  try {
    const jobs: LedgerTailRead = opts.jobsText !== undefined
      ? { state: 'read', text: opts.jobsText, truncated: false }
      : await readLedgerTail(jobsPath);
    if (jobs.state !== 'read') return visitSyncBase(jobs.state, jobsPath, queuePath, journalPath);
    const mergeEventsPath = join(runsDir, ROUTER_MERGE_EVENTS_LEDGER_RELATIVE);
    const mergeEvents: LedgerTailRead = opts.mergeEventsText !== undefined
      ? opts.mergeEventsText === null
        ? { state: 'missing' }
        : { state: 'read', text: opts.mergeEventsText, truncated: false }
      : await readLedgerTail(mergeEventsPath);
    const nowMs = now();
    const fold = queueVisitsFromJobs(
      jobs.text, nowMs,
      mergeEvents.state === 'read' ? foldMergeEventChecks(mergeEvents.text) : undefined,
    );
    const scanned = {
      rows: fold.rows, ignored: fold.ignored, invalid: fold.invalid,
      truncated: jobs.truncated,
      mergeEventsState: mergeEvents.state,
      mergeEventsTruncated: mergeEvents.state === 'read' ? mergeEvents.truncated : false,
    };
    if (opts.signal?.aborted) {
      return { ...visitSyncBase('read', jobsPath, queuePath, journalPath), ...scanned };
    }

    const queue = await queueTextOrInjected(opts.queueText, queuePath);
    if (opts.signal?.aborted) {
      return {
        ...visitSyncBase('read', jobsPath, queuePath, journalPath),
        ...scanned, queueState: queue.state,
      };
    }
    const readyVisits = queue.text === null ? [] : queueReadyVisits(queue.text, fold.jobs, nowMs);
    const visits = [...fold.visits, ...readyVisits];

    let existing: QueueVisit[];
    try {
      existing = await readQueueVisits(journalPath);
    } catch {
      return {
        ...visitSyncBase('read', jobsPath, queuePath, journalPath),
        ...scanned, queueState: queue.state, journalState: 'unreadable', derived: visits.length,
      };
    }
    const plan = planVisitSync(visits, existing);
    const result: QueueVisitSyncResult = {
      ...visitSyncBase('read', jobsPath, queuePath, journalPath),
      ...scanned, queueState: queue.state, journalState: 'read',
      derived: visits.length, unchanged: plan.unchanged, regression: plan.regression,
    };
    if (plan.append.length > 0 && !opts.signal?.aborted) {
      result.appended = await appendQueueVisits(plan.append, journalPath);
    }
    // The journal is append-only evidence, but every reader loads it whole —
    // keep it near the live evidence window. This pass's derived visits are
    // the keepKeys: anything still foldable from the bounded jobs tail or the
    // live queue survives compaction, so the next pass finds the same dedup
    // set and cannot churn dropped keys back in.
    if (!opts.signal?.aborted) {
      const keepKeys = new Set(visits.filter(isQueueVisit).map(queueVisitKey));
      const compaction = await compactQueueVisits(journalPath, { now: nowMs, keepKeys });
      result.journalCompacted = compaction.compacted;
      result.journalDropped = compaction.dropped;
    }
    return result;
  } catch {
    return visitSyncBase('error', jobsPath, queuePath, journalPath);
  }
}

