/**
 * Job-control steering ledger's recurring unacknowledged requests →
 * self-improvement backlog items.
 *
 * `phm job <pause|resume|stop|move>`, POST /api/verse/fleet/runs/control
 * and the desktop job detail all steer one fleet job through
 * requestJobControl (src/core/fleet/job-control.ts), which appends to the
 * append-only ledger at <runsDir>/queue/job-control.jsonl — one
 * fleet.job.control.v1 request row per accepted request
 * ({schema, requestId, at, action, job, lane, status, by}) plus the
 * acknowledgement rows the documented "dispatcher contract" expects
 * ({schema, requestId, status:'applied'|'refused', reason?, at} sharing the
 * requestId, the last status winning). The synchronous paths record
 * 'applied' at write time — a queued move through reassignQueuedJobs, a
 * live stop through stopJob — while pause, resume, move-of-a-live-job and
 * stop-of-a-queued-job record 'requested' and wait for the dispatcher to
 * act and acknowledge.
 *
 * Until now the ledger's only readers were display surfaces:
 * readJobControlLedger folds it for the session thread, which renders a
 * standing 'requested' row as "The dispatcher has not applied it yet."
 * No pass anywhere — not the daemon's tick or off-tick jobs, not the
 * self-tick hooks, not contrib/mac's dispatchd.py — consumes 'requested'
 * rows or appends their acknowledgements, so every asynchronously
 * steerable request is a permanent dead letter and the recurrence never
 * became work.
 *
 * jobControlBacklogItems carries the recorded requests into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling fleet-evidence feeds
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched. A
 *    missing or unreadable file yields no items.
 *  - Rows count only under the writer's contract: the same fold
 *    readJobControlLedger applies — one entry per requestId, the first
 *    contract-valid request row creating it (valid action, job and at
 *    strings plus a recordable status) and later rows updating status
 *    and reason, the last status winning. Malformed lines and rows that
 *    never form a valid request are skipped, never guessed.
 *  - Window membership is the request row's own `at`: a folded request
 *    counts only when its timestamp parses inside the window (plus the
 *    usual future-skew allowance). An acknowledgement is always appended
 *    after its request, so a retained request's acknowledgement is
 *    retained too — truncation can hide older requests but can never
 *    make an acknowledged request look unacknowledged; counts are a
 *    lower bound on the window, stated as such.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    testing burst: the cell emits only when unacknowledged requests
 *    reach JOB_CONTROL_MIN_UNACKED, cover JOB_CONTROL_MIN_JOBS distinct
 *    job ids and span JOB_CONTROL_MIN_DAYS distinct UTC days inside the
 *    7-day window. One job steered repeatedly, or one afternoon of
 *    trials, never queues a session.
 *  - Fleet machinery only: the ledger is this install's steering record,
 *    so items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    feeds apply.
 *  - Dedup is downstream: the item id hashes the cell kind — never the
 *    counts or timestamps — so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a ledger whose
 *    requests start being acknowledged simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, example job ids must match the fleet's own id
 *    shape and surface names the writer's own vocabulary before they are
 *    quoted, and the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  isJobControlAction,
  JOB_CONTROL_FILE,
  type JobControlAction,
} from '../fleet/job-control-types.js';
import { STRAY_ID_PATTERN } from '../fleet/stray-slots.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the fold produces at most one cell. */
export const JOB_CONTROL_BACKLOG_MAX_ITEMS = 4;
const JOB_CONTROL_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const JOB_CONTROL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on request timestamps, same convention the sibling folds apply. */
const JOB_CONTROL_FUTURE_SKEW_MS = 60_000;
/** Unacknowledged requests the cell needs inside the window before they count as recurring. */
export const JOB_CONTROL_MIN_UNACKED = 3;
/** Distinct job ids the unacknowledged requests must cover — one job's retries are not systemic. */
export const JOB_CONTROL_MIN_JOBS = 2;
/** Distinct UTC days the evidence must span — recurring means recorded across days. */
export const JOB_CONTROL_MIN_DAYS = 2;
/** Bounded tail for the steering ledger; a row is a few hundred bytes so this covers thousands of requests. */
const JOB_CONTROL_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Distinct surface tallies quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: steering evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The `by` surface vocabulary the writer records (cli, desktop, mobile, ...); same shape readLedger accepts. */
const BY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

export interface JobControlItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/job-control.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default JOB_CONTROL_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default JOB_CONTROL_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** The statuses the writer's rows can carry; 'unknown' is a receipt-only answer, never recorded. */
type RecordedStatus = 'requested' | 'applied' | 'refused';

/** One folded steering request: the request row's fields with its last recorded status. */
export interface JobControlRecord {
  requestId: string;
  action: JobControlAction;
  job: string;
  /** Move target lane for 'move' requests, else null. */
  lane: string | null;
  /** Final folded status: 'requested' while no acknowledgement ever landed. */
  status: RecordedStatus;
  /** The dispatcher's refusal reason on a 'refused' fold, else null. */
  reason: string | null;
  /** Request-row timestamp in ms; null when the recorded `at` does not parse. */
  atMs: number | null;
  /** Recording surface (cli, desktop, mobile), or null when the row named none. */
  by: string | null;
}

export interface JobControlJournalFold {
  /** Folded requests whose request timestamp landed inside the window. */
  requests: JobControlRecord[];
  /** Folded requests whose `at` did not parse — valid rows that cannot be windowed. */
  undated: number;
  /** Retained-tail lines that failed JSON parse or never formed a valid request. */
  invalidRows: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const recordedStatus = (value: unknown): RecordedStatus | null =>
  value === 'requested' || value === 'applied' || value === 'refused' ? value : null;

/**
 * Pure: fold one ledger tail into per-requestId records, the same contract
 * readJobControlLedger applies — the first contract-valid request row
 * creates the entry and later rows update status and reason, the last
 * status winning. Returns only requests whose `at` parses inside the
 * window; undated and out-of-window requests are counted, never guessed.
 */
export function foldJobControlJournal(text: string, nowMs: number, windowMs: number): JobControlJournalFold {
  const fold: JobControlJournalFold = { requests: [], undated: 0, invalidRows: 0 };
  const since = nowMs - windowMs;
  const until = nowMs + JOB_CONTROL_FUTURE_SKEW_MS;
  const entries = new Map<string, JobControlRecord>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) { fold.invalidRows += 1; continue; }
    const r = row as Record<string, unknown>;
    if (typeof r['requestId'] !== 'string' || r['requestId'] === '') { fold.invalidRows += 1; continue; }
    const status = recordedStatus(r['status']);
    const seen = entries.get(r['requestId']);
    if (seen !== undefined) {
      if (status !== null) {
        seen.status = status;
        seen.reason = typeof r['reason'] === 'string' ? r['reason'].slice(0, 200) : null;
      }
      continue;
    }
    if (status === null || !isJobControlAction(r['action']) || typeof r['job'] !== 'string' || typeof r['at'] !== 'string') {
      fold.invalidRows += 1;
      continue;
    }
    entries.set(r['requestId'], {
      requestId: r['requestId'],
      action: r['action'],
      job: r['job'],
      lane: typeof r['lane'] === 'string' ? r['lane'] : null,
      status,
      reason: null,
      atMs: parseLedgerTs(r['at']),
      by: typeof r['by'] === 'string' && BY_PATTERN.test(r['by']) ? r['by'] : null,
    });
  }
  for (const record of entries.values()) {
    if (record.atMs === null) { fold.undated += 1; continue; }
    if (record.atMs < since || record.atMs > until) continue;
    fold.requests.push(record);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** The one recurring cell: folded requests still standing at 'requested'. */
export interface JobControlUnackedCell {
  kind: 'unacked';
  /** Unacknowledged requests inside the window. */
  requests: number;
  /** Distinct job ids they cover. */
  jobs: number;
  /** Distinct UTC days the requests span, sorted. */
  days: string[];
  /** Per-action tallies of the unacknowledged requests, most frequent first. */
  actions: [JobControlAction, number][];
  /** Per-surface tallies of the unacknowledged requests, most frequent first. */
  surfaces: [string, number][];
  /** Up to MAX_EXAMPLES fleet-shaped job ids among the unacknowledged requests. */
  examples: string[];
  /** In-window folded requests that did reach a terminal status — the synchronous paths that work. */
  applied: number;
  refused: number;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

function tallyOf(map: Map<string, number>, max: number): [string, number][] {
  return [...map.entries()]
    .map(([text, count]) => [text, count] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max);
}

/**
 * Pure: the recurring unacknowledged-request cell the fold justifies. A
 * cell emits only while its requests reach JOB_CONTROL_MIN_UNACKED,
 * cover JOB_CONTROL_MIN_JOBS distinct job ids and span JOB_CONTROL_MIN_DAYS
 * distinct UTC days. Sorted deterministically (one cell today).
 */
export function jobControlCells(fold: JobControlJournalFold, lowerBound = false): JobControlUnackedCell[] {
  const unacked = fold.requests.filter((record) => record.status === 'requested');
  if (unacked.length < JOB_CONTROL_MIN_UNACKED) return [];
  const jobs = new Set(unacked.map((record) => record.job));
  if (jobs.size < JOB_CONTROL_MIN_JOBS) return [];
  const days = new Set(unacked.map((record) => dayOfMs(record.atMs!)));
  if (days.size < JOB_CONTROL_MIN_DAYS) return [];
  const actions = new Map<JobControlAction, number>();
  const surfaces = new Map<string, number>();
  const examples: string[] = [];
  let applied = 0;
  let refused = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const record of fold.requests) {
    if (record.status === 'applied') applied += 1;
    else if (record.status === 'refused') refused += 1;
    if (record.status !== 'requested') continue;
    actions.set(record.action, (actions.get(record.action) ?? 0) + 1);
    if (record.by !== null) surfaces.set(record.by, (surfaces.get(record.by) ?? 0) + 1);
    if (STRAY_ID_PATTERN.test(record.job) && !examples.includes(record.job) && examples.length < MAX_EXAMPLES) {
      examples.push(record.job);
    }
    firstMs = firstMs === null ? record.atMs! : Math.min(firstMs, record.atMs!);
    lastMs = lastMs === null ? record.atMs! : Math.max(lastMs, record.atMs!);
  }
  return [{
    kind: 'unacked',
    requests: unacked.length,
    jobs: jobs.size,
    days: [...days].sort(),
    actions: [...actions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    surfaces: tallyOf(surfaces, MAX_PROMPT_TALLIES),
    examples,
    applied,
    refused,
    firstSeen: firstMs === null ? null : new Date(firstMs).toISOString(),
    lastSeen: lastMs === null ? null : new Date(lastMs).toISOString(),
    lowerBound,
  }];
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const NO_CHANGE = 'If the window has rolled forward, the unacknowledged rows trace to requests whose jobs finished while pending — expected residue, not a dead apply path — the steering verbs were exercised once for evaluation and never adopted, or the intended consumer is owner-side or pinned ops machinery — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is queue/job-control.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the append-only fleet.job.control.v1 steering ledger requestJobControl (src/core/fleet/job-control.ts) writes for `phm job <action>`, POST /api/verse/fleet/runs/control and the desktop job detail — one request row per accepted request plus the applied/refused acknowledgement rows the documented dispatcher contract expects. readJobControlLedger folds the same file for the session-thread display, which renders a standing \'requested\' row as "The dispatcher has not applied it yet." Until this feed the ledger\'s only readers were those display surfaces, so requests nothing applies never became work.';

const pct = (part: number, whole: number): string => (whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(1)}%`);

const actionText = (actions: readonly [JobControlAction, number][]): string =>
  actions.map(([action, count]) => `${action} ×${count}`).join(', ');

const surfaceText = (surfaces: readonly [string, number][]): string =>
  surfaces.length === 0 ? 'no recorded surface' : surfaces.map(([name, count]) => `'${name}' ×${count}`).join(', ');

const boundText = (cell: JobControlUnackedCell): string =>
  cell.lowerBound ? ' The ledger tail was truncated at the bounded read, so these counts cover only the retained rows — a lower bound, not the full window.' : '';

function jobControlPrompt(cell: JobControlUnackedCell): string {
  const total = cell.requests + cell.applied + cell.refused;
  return [
    `Phantom's job-control ledger keeps recording steering requests that are never acknowledged — ${cell.requests} request(s) across ${cell.jobs} distinct job(s) on ${cell.days.length} UTC day(s) inside the 7-day window still stand at status 'requested' — the self-improvement work this backlog exists for.`,
    '',
    `Each row is one fleet.job.control.v1 request — pause, resume, stop or move — recorded by requestJobControl for \`phm job <action>\`, POST /api/verse/fleet/runs/control or the desktop job detail. The file's documented contract says the dispatcher acts on 'requested' lines and appends an applied/refused acknowledgement sharing the requestId; the session thread renders a standing 'requested' row as "The dispatcher has not applied it yet." In-window context: ${cell.applied} request(s) reached 'applied' and ${cell.refused} 'refused' — the synchronous paths (a queued move through reassignQueuedJobs, a live stop through stopJob) that never needed the dispatcher — while these ${cell.requests} of ${total} folded request(s) (${pct(cell.requests, total)}) never moved past 'requested'. Action mix: ${actionText(cell.actions)}. Surfaces: ${surfaceText(cell.surfaces)}.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${cell.examples.length > 0 ? ` Example job ids: ${cell.examples.join(', ')}.` : ''}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the request/ack contract (src/core/fleet/job-control.ts and job-control-types.ts), every fleet pass that could consume 'requested' rows — the daemon's tick and off-tick jobs under src/core/daemon, the self-tick hooks under src/core/fleet, the CLI fleet verbs — and the job lifecycle they would act on. contrib/mac's dispatchd.py and the live copies under ~/.ashlr-runs/bin are pinned ops machinery: Security-reviewed, re-pinned, never edited live.`,
    '',
    `Find whether any pass consumes 'requested' rows before assuming the apply side exists — grep for JOB_CONTROL_FILE and readJobControlLedger consumers across src/ and contrib/. If none does, the pause/resume/move-of-a-live-job/stop-of-a-queued-job verbs are dead letters: implement the apply pass where this repo owns it — a bounded consumer that reads standing 'requested' rows, applies what it can through the existing job-stop/reassign paths and appends the acknowledgement the contract specifies — or, if the intended consumer is the pinned dispatcher itself, report no-change naming the pinned boundary. Requests whose jobs finished while pending are expected residue; the recurring bar across distinct jobs and days is what makes this systemic. ${NO_CHANGE}`,
  ].join('\n');
}

function jobControlItem(cell: JobControlUnackedCell, repo: string): CloudBacklogItem {
  const id = `fleet-job-control-${createHash('sha256').update(`job-control:${cell.kind}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: 'Job-control steering requests are recorded but never acknowledged'.slice(0, MAX_TITLE_CHARS),
    prompt: jobControlPrompt(cell),
    area: 'job-control',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the job-control ledger's recurring unacknowledged
 * requests. Total: a missing ledger, another repository or any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function jobControlBacklogItems(opts: JobControlItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : JOB_CONTROL_WINDOW_MS;
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const tail = await readLedgerTail(join(runsDir, JOB_CONTROL_FILE), JOB_CONTROL_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldJobControlJournal(tail.text, nowMs, windowMs);
    if (fold.requests.length === 0) return [];
    const cells = jobControlCells(fold, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? JOB_CONTROL_BACKLOG_MAX_ITEMS, JOB_CONTROL_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => jobControlItem(cell, repo));
  } catch {
    return [];
  }
}
