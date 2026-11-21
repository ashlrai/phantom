/**
 * visit-sync.ts — producer for the queue visit journal (journal.ts), which
 * `phm queue stats` and `GET /api/queue/stats` read but fleet events never
 * wrote. Folds `metrics/jobs.jsonl` (per-attempt lifecycle; `launch` rows
 * delimit attempts) and live `- READY` rows of `queue/router-queue.md` into
 * `QueueVisit` snapshots. Station mapping and honesty rules:
 * docs/QUEUE-STATS.md. Derived timestamps only — missing boundaries leave a
 * visit open or absent, never zero-filled; rows after `now` are ignored.
 */
import { parseLedgerTs } from '../metrics/loop.js';
import { isQueueVisit, type QueueVisit } from './stats.js';

export const VISIT_SYNC_SCHEMA = 'queue.visits-sync.v1';

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
    lane: str(row.lane ?? row.pool),
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
 */
function visitsForJob(job: string, events: LedgerEvent[]): { visits: QueueVisit[]; invalid: number } {
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

    // pr-ci: entry is the PR opening; ci_start is the service start when the
    // ledger carries it, otherwise the whole dwell reports as wait.
    if (publish) {
      const after = win.filter(e => e.order > publish.order);
      const ciStart = earliest(after, ['ci_start']);
      const exit = earliest(
        [...after.filter(e => e.kind === 'ci_complete'), ...exits.filter(e => e.order > publish.order)],
        ['ci_complete', 'merged', 'closed']);
      const started = ciStart && (!exit || ciStart.at <= exit.at) ? ciStart.at : exit?.at;
      push(makeVisit(job, attempt, STATION_PR_CI, pool, publish.at, started, exit?.at));
    }

    // merge-queue: entry needs a ci_complete boundary; exit is merge or a
    // matched terminal. Missing ci_complete stays absent rather than guessed.
    const ciComplete = earliest(win, ['ci_complete']);
    if (ciComplete) {
      const exit = exits.find(e => e.order > ciComplete.order) ?? null;
      push(makeVisit(job, attempt, STATION_MERGE_QUEUE, pool, ciComplete.at, exit?.at, exit?.at));
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
 */
export function queueVisitsFromJobs(text: string | null, now = Date.now()): JobsVisitFold {
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
    const fold = visitsForJob(job, events);
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
    latest.set(JSON.stringify([v.station, v.pool, v.id]), v);
  }
  const plan: VisitSyncPlan = { append: [], unchanged: 0, regression: 0 };
  for (const candidate of visits) {
    if (!isQueueVisit(candidate)) continue;
    const key = JSON.stringify([candidate.station, candidate.pool, candidate.id]);
    const prior = latest.get(key);
    if (!prior) { plan.append.push(candidate); continue; }
    if (completeness(candidate) < completeness(prior)) { plan.regression++; continue; }
    if (sameVisit(candidate, prior)) { plan.unchanged++; continue; }
    plan.append.push(candidate);
  }
  return plan;
}

