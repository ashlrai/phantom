/**
 * Merge-bottleneck recut-loop journals → self-improvement backlog items.
 *
 * While the desktop app is open, recutLoopTick (src/core/fleet/recut-loop.ts,
 * armed once by GET /api/verse/health) watches the open-PR merge backlog and
 * drops a recut job for every stale fleet PR itself. Each successful publish
 * appends one {at, pr, id, headSha, baseSha?, file} row to
 * queue/recut-loop.jsonl under the fleet runs directory, and every attempt
 * first appends a pre-publication reservation — the same fields plus
 * leaseUntil — to queue/recut-loop-leases.jsonl. The dedupe that guards
 * re-cutting is deliberately layered: a PR written within 24 h on the same
 * head is skipped, an in-flight prompt naming pull/<N>/head blocks a second
 * mint, EMPTY_YIELD_STREAK same-head attempts that all finished empty
 * suppress the next one, and caps bound writes per tick and per hour — all
 * keyed off the write ledger and the jobs ledger. Until now the journals'
 * only readers were those in-tick guards plus the last-tick outcome kept in
 * module state for GET /api/verse/health/recut-loop and the Verse recut-loop
 * model — reports and guard inputs someone had to run or that steer one
 * pass at a time. Two evidence kinds never became work:
 *
 *  - Recurring re-cuts: a PR number the loop keeps publishing recut jobs
 *    for across distinct UTC days inside the window — every repeat means
 *    the conflict regenerated (a moved head or base) or earlier recuts
 *    never held, and each minted job burned a launch slot on the same
 *    merge bottleneck.
 *  - Unresolved reservations: lease rows that expired without a matching
 *    published-job row — a failed writeJob, a tick that died mid-publish,
 *    or a lost ledger append after a successful publish. Every one is a
 *    reservation the ledger-keyed guards (the 24 h window, the empty-yield
 *    streak, the hour cap) cannot see, so recurring orphans mean the
 *    loop's own audit chain has gaps exactly where its dedupe reads.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both journals are read once through readLedgerTail's
 *    bounded no-follow tail and metrics/jobs.jsonl through the same
 *    ROUTER_OUTCOME_LEDGER_LIMIT window the router outcome fold reads;
 *    nothing is written and no network is touched. A missing or
 *    unreadable write journal yields no recurrence items; a missing or
 *    unreadable lease journal yields no reservation items; each signal
 *    stands alone.
 *  - Rows count only under the writer's contract: JSON objects with a
 *    parseable `at`, a safe-integer `pr` >= 1, a bounded safe `id`, a
 *    `headSha` string and optional `baseSha`/`file` strings — the same
 *    shape parseLedgerLine validates. Lease rows additionally carry the
 *    optional finite `leaseUntil` the writer always sets; a missing or
 *    non-finite one falls back to the writer's ten-minute reservation
 *    window from `at`. Malformed lines, undated or future-dated rows and
 *    unsafe ids are skipped, never guessed.
 *  - Recurring means recorded across days: a PR emits only at
 *    RECUT_LOOP_MIN_WRITES published rows across RECUT_LOOP_MIN_DAYS
 *    distinct UTC days inside the 7-day window — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply. The write
 *    journal's own dedupe (24 h per head, in-flight, empty-yield, caps)
 *    means surviving repeats are already the residue those guards let
 *    through.
 *  - Reservations count only once expired: a lease whose effective
 *    expiry (leaseUntil, else at + the writer's ten-minute window) is
 *    still ahead of the clock may yet convert, so it is skipped rather
 *    than called orphaned. A reservation resolves when the write
 *    journal carries a row matching the writer's own lease-check triple
 *    — same pr, id and headSha — stamped within the same tick's
 *    timestamp (ids are minted unique per attempt, RECUT<pr>L<k>, so
 *    the triple is the conversion proof and a recycled id's
 *    much-later publish never counts). Orphan items emit only while
 *    the write tail is whole: a truncated write journal could hide the
 *    matching row and turn every retained lease into a false orphan,
 *    so that signal is withheld rather than emitted on suspect
 *    evidence; truncated tails are otherwise stated as lower bounds.
 *  - Outcome evidence joins, never gates: each PR's recorded job ids
 *    (RQ-PHX-<id>) fold their launches, finishes (empty or not), PR
 *    publishes, aborts and resolved outcome states inside the same
 *    window so the prompt can say whether the recuts landed, never
 *    launched or kept finishing empty. Tallies quote only what the
 *    retained tail recorded — truncation is stated as a lower bound,
 *    and a withheld jobs ledger degrades the tallies to unknown rather
 *    than suppressing the journal evidence or zero-filling it.
 *  - Fleet machinery only: the loop is hardcoded to this install's
 *    repository (RECUT_REPO = 'ashlrai/phantom' in the writer), so items
 *    emit only for the fleet's own repository — the same last-segment
 *    rule the sibling fleet-evidence sources apply. Dedup is downstream:
 *    item ids hash the PR number or the reservation signal only, never
 *    the tallies or timestamps, so a refresh re-derives the same id and
 *    a PR that stops recurring simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerPhase, ledgerPrUrl, ledgerStateTokens } from '../fleet/empty-cause.js';
import {
  isNodePoolLedgerRow,
  ledgerEventTs,
  ledgerJobId,
  ledgerLifecycleEvent,
  ledgerOutcomeState,
} from '../fleet/jobs-ledger-dialect.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';

/** Items one call may emit; recurring PR cells and the reservation cell are a small set by construction. */
export const RECUT_LOOP_BACKLOG_MAX_ITEMS = 8;
const RECUT_LOOP_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const RECUT_LOOP_WINDOW_HOURS = 168;
/** A PR emits only at this many published recut rows inside the window... */
export const RECUT_LOOP_MIN_WRITES = 3;
/** ...across at least this many distinct UTC days. */
export const RECUT_LOOP_MIN_DAYS = 2;
/** Unresolved reservations emit only at this many expired orphans inside the window... */
export const RECUT_LOOP_MIN_LEASES = 3;
/** ...across at least this many distinct UTC days. */
export const RECUT_LOOP_MIN_LEASE_DAYS = 2;
/**
 * Bounded tail of each append-only journal — far past the writer's own
 * 64 KiB guard read, so the fold sees the whole 7-day window even on a
 * busy install; prompts state any truncation as a lower bound (or, for
 * the write journal, withhold the reservation signal entirely).
 */
const RECUT_LOOP_TAIL_BYTES = 1024 * 1024;
/** The jobs ledger shares the router outcome fold's bounded tail. */
const RECUT_LOOP_JOBS_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** The fleet's own repository label: the loop only ever writes this install's recuts. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger-recorded ids are bounded safe text; the writer mints RECUT<pr>L<k>. */
const SAFE_LEDGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Queue job ids the loop's publishes mint: RQ-PHX-RECUT<pr>L<level>. */
const RECUT_JOB_ID = /^RQ-PHX-RECUT[0-9]{1,15}L[0-9]$/;
/** The writer's pre-publication reservation window (recut-loop.ts LEASE_MS). */
const LEASE_MS = 10 * 60 * 1000;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Per-PR unresolved-reservation tallies and head SHAs quoted inside prompts. */
const MAX_PROMPT_PRS = 4;

export interface RecutLoopItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/recut-loop*.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default RECUT_LOOP_WINDOW_HOURS). */
  windowHours?: number;
  /** Write-journal override (default: <runsDir>/queue/recut-loop.jsonl). */
  writesPath?: string;
  /** Lease-journal override (default: <runsDir>/queue/recut-loop-leases.jsonl). */
  leasesPath?: string;
  /** Jobs ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  jobsPath?: string;
  /** Injected write-journal text (tests); skips the journal read when set — null means missing. */
  writesText?: string | null;
  /** Injected lease-journal text (tests); skips the journal read when set — null means missing. */
  leasesText?: string | null;
  /** Injected jobs-ledger text (tests); skips the ledger read when set — null means withheld. */
  jobsText?: string | null;
  /** Most items one call emits (default RECUT_LOOP_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and lease freshness (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Folds — the write journal, the reservation journal and the jobs-ledger join
// ---------------------------------------------------------------------------

export interface RecutWriteFold {
  /** pr → in-window fold before the recurring bars apply. */
  prs: Map<number, {
    writes: number;
    days: Set<string>;
    firstMs: number | null;
    lastMs: number | null;
    /** Queue job ids the writes minted, for the jobs-ledger join. */
    jobIds: Set<string>;
    /** Distinct head SHAs the writes recorded. */
    headShas: Set<string>;
  }>;
  /**
   * Every contract-valid row's resolution key — `${pr} ${id} ${headSha}`,
   * the triple the writer's own lease check compares — mapped to the
   * write timestamps recorded under it. The tick stamps lease and write
   * with the same `at`, so a reservation resolves only against a write
   * within the skew window, never a recycled id's later publish.
   */
  published: Map<string, number[]>;
  /** Non-blank lines that were not contract-valid rows. */
  malformed: number;
}

/**
 * Pure: fold one write-journal tail into per-PR write counts plus the
 * published (pr, id, headSha) resolution map. Only rows inside the window count;
 * malformed JSON, rows failing the writer's contract (missing/bad pr or
 * at, unsafe id, non-string headSha) and future-dated rows are skipped,
 * never guessed.
 */
export function foldRecutWriteJournal(text: string, nowMs: number, windowHours: number): RecutWriteFold {
  const fold: RecutWriteFold = { prs: new Map(), published: new Map(), malformed: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { fold.malformed++; continue; }
    if (!isRecord(row)) { fold.malformed++; continue; }
    const pr = row['pr'];
    const id = row['id'];
    const at = row['at'];
    const headSha = row['headSha'];
    if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1) continue;
    if (typeof id !== 'string' || !SAFE_LEDGER_ID.test(id)) continue;
    if (typeof at !== 'string') continue;
    if (typeof headSha !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs) || atMs < since || atMs > until) continue;
    let cell = fold.prs.get(pr);
    if (cell === undefined) {
      cell = { writes: 0, days: new Set(), firstMs: null, lastMs: null, jobIds: new Set(), headShas: new Set() };
      fold.prs.set(pr, cell);
    }
    cell.writes += 1;
    cell.days.add(dayOf(atMs));
    cell.jobIds.add(`RQ-PHX-${id}`);
    if (headSha !== '') cell.headShas.add(headSha);
    cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
    cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
    const key = `${pr} ${id} ${headSha}`;
    const times = fold.published.get(key);
    if (times === undefined) fold.published.set(key, [atMs]);
    else times.push(atMs);
  }
  return fold;
}

/** One contract-valid reservation row inside the window. */
export interface RecutLeaseEntry {
  atMs: number;
  pr: number;
  id: string;
  headSha: string;
  /** Effective reservation expiry: leaseUntil when finite, else at + the writer's ten-minute window. */
  expiresMs: number;
}

export interface RecutLeaseFold {
  /** Contract-valid in-window reservations, append order. */
  leases: RecutLeaseEntry[];
  /** Non-blank lines that were not contract-valid rows. */
  malformed: number;
}

/**
 * Pure: fold one lease-journal tail into its in-window reservations.
 * Same row contract as the write journal plus the optional finite
 * `leaseUntil`; a missing or non-finite one falls back to at + LEASE_MS,
 * the writer's own reservation window. Malformed lines and off-contract
 * rows are skipped, never guessed.
 */
export function foldRecutLeaseJournal(text: string, nowMs: number, windowHours: number): RecutLeaseFold {
  const fold: RecutLeaseFold = { leases: [], malformed: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { fold.malformed++; continue; }
    if (!isRecord(row)) { fold.malformed++; continue; }
    const pr = row['pr'];
    const id = row['id'];
    const at = row['at'];
    const headSha = row['headSha'];
    if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1) continue;
    if (typeof id !== 'string' || !SAFE_LEDGER_ID.test(id)) continue;
    if (typeof at !== 'string') continue;
    if (typeof headSha !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs) || atMs < since || atMs > until) continue;
    const leaseUntil = row['leaseUntil'];
    const expiresMs = typeof leaseUntil === 'number' && Number.isFinite(leaseUntil) ? leaseUntil : atMs + LEASE_MS;
    fold.leases.push({ atMs, pr, id, headSha, expiresMs });
  }
  return fold;
}

/** Recorded outcome tallies for one recut job inside the window — every count is ledger-recorded, never inferred. */
export interface RecutJobTally {
  launches: number;
  finishes: number;
  /** Finishes or publishes that ended the job with no change (empty:true, EMPTY_DONE, publish class 'empty'). */
  emptyFinishes: number;
  /** Publish rows claiming a PR (class 'pr' or carrying a PR url). */
  prs: number;
  /** Publish rows whose class starts with 'abort'. */
  aborts: number;
  /** Resolved outcome states: MERGED verdicts, CLOSED verdicts and every other resolved phase. */
  merged: number;
  closed: number;
  resolvedOther: number;
}

const emptyTally = (): RecutJobTally => ({ launches: 0, finishes: 0, emptyFinishes: 0, prs: 0, aborts: 0, merged: 0, closed: 0, resolvedOther: 0 });

/**
 * Pure: fold one jobs-ledger tail into per-recut-job outcome tallies.
 * Only rows for `RQ-PHX-RECUT<pr>L<k>` job ids inside the window count;
 * node-pool producer schemas, malformed lines, unsafe job ids and
 * undated rows are skipped, never guessed.
 */
export function foldRecutJobOutcomes(text: string, nowMs: number, windowHours: number): Map<string, RecutJobTally> {
  const out = new Map<string, RecutJobTally>();
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    // Cheap prefilter: recut jobs are a small minority of the ledger's rows.
    if (!line.includes('RQ-PHX-RECUT')) continue;
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row)) continue;
    if (isNodePoolLedgerRow(row)) continue;
    const job = ledgerJobId(row);
    if (job === null || !RECUT_JOB_ID.test(job)) continue;
    const phase = ledgerPhase(row);
    const atMs = ledgerEventTs(row, phase);
    if (atMs === null || atMs < since || atMs > until) continue;
    const event = ledgerLifecycleEvent(row, phase);
    let tally = out.get(job);
    if (tally === undefined) {
      tally = emptyTally();
      out.set(job, tally);
    }
    if (event === 'launch') {
      tally.launches += 1;
      continue;
    }
    if (event === 'finish') {
      tally.finishes += 1;
      if (row['empty'] === true || ledgerStateTokens(row).includes('EMPTY_DONE')) tally.emptyFinishes += 1;
    } else if (event === 'publish') {
      // The slot-yield publish convention: class 'pr' or an unclassified
      // row carrying a PR url is a PR claim; 'empty' ends the job with no
      // change; 'abort*' is an aborted attempt; anything else records no
      // publish verdict and is skipped, never guessed.
      const kind = typeof row['class'] === 'string' ? row['class'].trim().toLowerCase() : '';
      if (kind === 'empty') tally.emptyFinishes += 1;
      else if (kind.startsWith('abort')) tally.aborts += 1;
      else if (kind === 'pr' || ((kind === '' || kind === 'unknown') && ledgerPrUrl(row) !== null)) tally.prs += 1;
    }
    const state = ledgerOutcomeState(row, event, phase);
    if (state === 'MERGED') tally.merged += 1;
    else if (state === 'CLOSED') tally.closed += 1;
    else if (state !== null) tally.resolvedOther += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface RecutTally {
  /** Sanitized recorded text (a head SHA prefix or reservation id stem). */
  text: string;
  count: number;
}

/** One emitted recurring PR: the write fold plus the joined job tallies. */
export interface RecutPrCell {
  /** The pull request number the loop keeps re-cutting. */
  pr: number;
  /** Recorded published recuts inside the window. */
  writes: number;
  /** Sorted distinct UTC days the writes landed on. */
  days: string[];
  /** Queue job ids the writes minted (RQ-PHX-RECUT<pr>L<k>), sorted. */
  jobIds: string[];
  /** Newest recorded head SHA prefixes, most recent first (bounded). */
  heads: string[];
  /** Joined jobs-ledger tallies summed across jobIds; null when the ledger was withheld. */
  jobs: RecutJobTally | null;
  /** ISO bounds of the cell's writes; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the write journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
  /** True when the jobs ledger's bounded tail was truncated: job tallies are a lower bound. */
  jobsLowerBound: boolean;
}

/** The fleet-level unresolved-reservation cell. */
export interface RecutLeaseCell {
  /** Expired reservations inside the window with no matching published-job row. */
  unresolved: number;
  /** Sorted distinct UTC days the orphans landed on. */
  days: string[];
  /** Per-PR unresolved tallies, most frequent first. */
  byPr: RecutTally[];
  /** ISO bounds of the orphan reservations; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the lease journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

function tallyOf(map: Map<string, number>, max: number): RecutTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const sumTally = (tallies: Iterable<RecutJobTally>): RecutJobTally => {
  const out = emptyTally();
  for (const t of tallies) {
    out.launches += t.launches;
    out.finishes += t.finishes;
    out.emptyFinishes += t.emptyFinishes;
    out.prs += t.prs;
    out.aborts += t.aborts;
    out.merged += t.merged;
    out.closed += t.closed;
    out.resolvedOther += t.resolvedOther;
  }
  return out;
};

/**
 * Pure: recurring re-cut cells — a PR number recorded often enough across
 * enough distinct UTC days inside the window. Sorted by write count, the
 * most-recut PR first.
 */
export function recutPrCells(
  fold: RecutWriteFold,
  jobs: ReadonlyMap<string, RecutJobTally> | null,
  opts: { lowerBound?: boolean; jobsLowerBound?: boolean } = {},
): RecutPrCell[] {
  const cells: RecutPrCell[] = [];
  for (const [pr, cell] of fold.prs) {
    if (cell.writes < RECUT_LOOP_MIN_WRITES || cell.days.size < RECUT_LOOP_MIN_DAYS) continue;
    const jobIds = [...cell.jobIds].sort();
    const heads = [...cell.headShas].slice(-MAX_PROMPT_PRS).map((h) => h.slice(0, 12));
    cells.push({
      pr,
      writes: cell.writes,
      days: [...cell.days].sort(),
      jobIds,
      heads,
      jobs: jobs === null ? null : sumTally(jobIds.map((id) => jobs.get(id)).filter((t): t is RecutJobTally => t !== undefined)),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound: opts.lowerBound === true,
      jobsLowerBound: opts.jobsLowerBound === true,
    });
  }
  return cells.sort((a, b) => b.writes - a.writes || a.pr - b.pr);
}

/**
 * Pure: the unresolved-reservation cell — expired lease rows inside the
 * window whose (pr, id, headSha) triple never appears as a same-tick
 * published write. `nowMs`
 * decides freshness: a reservation whose effective expiry is still ahead
 * may yet convert and is skipped, never called orphaned. Sorted days and
 * per-PR tallies are quoted inside the prompt.
 */
export function recutLeaseCell(
  leases: readonly RecutLeaseEntry[],
  published: ReadonlyMap<string, readonly number[]>,
  opts: { nowMs: number; lowerBound?: boolean },
): RecutLeaseCell | null {
  const byPr = new Map<number, number>();
  const days = new Set<string>();
  let unresolved = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const lease of leases) {
    if (lease.expiresMs > opts.nowMs) continue;
    const times = published.get(`${lease.pr} ${lease.id} ${lease.headSha}`);
    if (times !== undefined && times.some((t) => Math.abs(t - lease.atMs) <= SKEW_MS)) continue;
    unresolved += 1;
    days.add(dayOf(lease.atMs));
    byPr.set(lease.pr, (byPr.get(lease.pr) ?? 0) + 1);
    firstMs = firstMs === null ? lease.atMs : Math.min(firstMs, lease.atMs);
    lastMs = lastMs === null ? lease.atMs : Math.max(lastMs, lease.atMs);
  }
  if (unresolved < RECUT_LOOP_MIN_LEASES || days.size < RECUT_LOOP_MIN_LEASE_DAYS) return null;
  const prTallies = new Map<string, number>();
  for (const [pr, count] of byPr) prTallies.set(String(pr), count);
  return {
    unresolved,
    days: [...days].sort(),
    byPr: tallyOf(prTallies, MAX_PROMPT_PRS),
    firstSeen: isoOrNull(firstMs),
    lastSeen: isoOrNull(lastMs),
    lowerBound: opts.lowerBound === true,
  };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is queue/recut-loop.jsonl and queue/recut-loop-leases.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the merge-bottleneck recut loop\'s own journals (src/core/fleet/recut-loop.ts recutLoopTick, armed once by GET /api/verse/health while the desktop app is open). Every tick that finds a DIRTY-conflicted `bridge: RQ-` PR past the superseded, 24-hour-same-head, in-flight, empty-yield-streak and cap guards mints a RECUT<pr>L<k> drop job and appends one {at, pr, id, headSha, baseSha?, file} row per successful publish to the write journal, plus one reservation row carrying leaseUntil to the lease journal before publishing. The journals\' only other readers are those in-tick guards and the last-tick outcome kept in module state for GET /api/verse/health/recut-loop and the Verse recut-loop model. The outcome join reads metrics/jobs.jsonl through the same bounded tail `phm jobs yield --by source`, `phm router outcomes` and the router outcome fold use: launches, finishes (empty or not), PR publishes, aborts and resolved outcome states for each RQ-PHX-RECUT* job inside the same window.';

const NO_CHANGE = 'If the window has rolled forward, each repeat was a legitimately new conflict on a moved head or base that earlier recuts could not have prevented, every recorded attempt landed its PR and merged or the PR closed as superseded, the reservations all resolved on retry, or the cause is pinned ops machinery, host state or owner-only — report no-change and name the evidence.';

const tallyText = (tallies: readonly RecutTally[]): string =>
  tallies.map((t) => `#${t.text} ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (firstSeen: string | null, lastSeen: string | null): string => {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen
    ? ` First recorded ${firstSeen}.`
    : ` First recorded ${firstSeen}, last ${lastSeen}.`;
};

const jobIdsText = (cell: RecutPrCell): string =>
  cell.jobIds.length <= 4 ? cell.jobIds.join(', ') : `${cell.jobIds.slice(0, 4).join(', ')} (+${cell.jobIds.length - 4} more)`;

/** The jobs-ledger sentence: recorded tallies, or the withheld-evidence wording — never a zero guess. */
function jobsText(cell: RecutPrCell): string {
  const jobs = cell.jobs;
  if (jobs === null) {
    return ' The jobs ledger was unavailable, so whether the recut jobs launched, finished empty, merged or closed is unknown — not zero.';
  }
  const parts = [
    `${jobs.launches} launch(es)`,
    `${jobs.finishes} finish(es)`,
    `${jobs.emptyFinishes} empty finish(es)/publish(es)`,
    `${jobs.prs} PR publish(es)`,
    `${jobs.aborts} abort(s)`,
    `${jobs.merged} MERGED outcome(s)`,
    `${jobs.closed} CLOSED outcome(s)`,
    `${jobs.resolvedOther} other resolved outcome(s)`,
  ];
  return ` Inside the same window the jobs ledger recorded across ${cell.jobIds.length} recut job(s) (${jobIdsText(cell)}): ${parts.join(', ')}.${cell.jobsLowerBound ? ' The jobs-ledger tail was truncated at the bounded read, so these tallies cover only the retained window — a lower bound, not the full window.' : ''}`;
}

function recutPrompt(cell: RecutPrCell): string {
  const heads = cell.heads.length === 0 ? '' : ` Recorded head SHAs: ${cell.heads.join(', ')}.`;
  return [
    `Phantom's merge-bottleneck recut loop keeps re-cutting the same pull request — PR #${cell.pr} had ${cell.writes} published recut jobs inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each recorded row is one successful publishDropJob-equivalent write of a fresh RECUT${cell.pr}L<k> job: the loop's own guards let the same PR through again, which means every earlier attempt either never landed, finished without holding, or the conflict genuinely regenerated on a moved head or base — and each repeat burned a launch slot re-doing work the fleet already tried.${heads}${seenText(cell.firstSeen, cell.lastSeen)}${jobsText(cell)}`,
    cell.lowerBound ? ' The write journal tail was truncated at the bounded read, so the write count covers only the retained window — a lower bound, not the full window.' : '',
    '',
    EVIDENCE,
    '',
    `Find out why this PR keeps needing recuts: join the named job ids to their launch, finish, publish and outcome rows in metrics/jobs.jsonl ('phm jobs yield' and 'phm jobs empty' folds), check whether earlier recuts merged while the PR stayed open (a superseded-close that never ran), finished empty (the empty-yield streak only suppresses after two on the same head and base), or the conflict is systemic — a hot file, a generated artifact or a version file every merge touches. Fix the cause in this repository — the recut prompt, the guards' evidence reads, the merge-bottleneck path or the offending repo content — not the symptom.`,
    '',
    `Run the affected suite (test/recut-loop*.test.ts, test/improve-*-backlog.test.ts as relevant). ${NO_CHANGE}`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

function recutItem(cell: RecutPrCell, repo: string): CloudBacklogItem {
  return {
    id: `recut-loop-${sha(`recut-loop:write:${cell.pr}`)}`,
    title: `Recut loop keeps re-cutting PR #${cell.pr}`.slice(0, MAX_TITLE_CHARS),
    prompt: recutPrompt(cell),
    area: 'recut-loop',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function leasePrompt(cell: RecutLeaseCell): string {
  return [
    `Phantom's merge-bottleneck recut loop keeps leaving publish reservations unaccounted — ${cell.unresolved} expired reservation(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) never produced a matching published-job row in queue/recut-loop.jsonl, the self-improvement work this backlog exists for.`,
    '',
    `Each reservation is appended before the publish attempt and resolves only when the write journal carries the same (pr, id, headSha) triple stamped by the same tick — ids are minted unique per attempt, so the triple is the conversion proof. An unresolved reservation is one of three recorded-but-indistinguishable outcomes: writeJob refused or threw (a 'write-failed'/'exists' skip), the tick died between reservation and publish, or the job published but the ledger append was lost — and in every case the ledger-keyed guards (the 24 h same-head window, the empty-yield streak, the rolling-hour cap) cannot see the attempt. Per-PR tallies: ${tallyText(cell.byPr)}.${seenText(cell.firstSeen, cell.lastSeen)}`,
    cell.lowerBound ? ' The lease journal tail was truncated at the bounded read, so the unresolved count covers only the retained window — a lower bound, not the full window.' : '',
    '',
    EVIDENCE,
    '',
    `Find out which side of the reservation-to-publish path keeps failing: check whether queue/recut-loop-leases.jsonl rows cluster on write-failed skips (the drop-job writer's validation or the link(2) publish refusing), on ticks that died mid-publish (the health endpoint's lastError), or on published jobs whose ledger append never landed (drop files present under leader/drop with no write row). The fix lives in this repository — the reservation lifecycle, the append ordering, or the guard reads that depend on the write ledger — not in the symptom.`,
    '',
    `Run the affected suite (test covering src/core/fleet/recut-loop.ts). ${NO_CHANGE}`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

function leaseItem(cell: RecutLeaseCell, repo: string): CloudBacklogItem {
  return {
    id: `recut-loop-${sha('recut-loop:leases')}`,
    title: 'Recut reservations keep missing their published-job rows'.slice(0, MAX_TITLE_CHARS),
    prompt: leasePrompt(cell),
    area: 'recut-loop',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the recut loop's recurring re-cut and unresolved-
 * reservation evidence. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function recutLoopBacklogItems(opts: RecutLoopItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? RECUT_LOOP_WINDOW_HOURS;

    // The write journal is the recurrence evidence: missing or unreadable
    // means there is nothing to fold — never a fabricated recurrence.
    let writesText: string | null;
    let writesLowerBound = false;
    let writesWhole = false;
    if (opts.writesText !== undefined) {
      writesText = opts.writesText;
      writesWhole = true; // injected text is whole by definition
    } else {
      const path = opts.writesPath ?? join(runsDir, 'queue', 'recut-loop.jsonl');
      const tail = await readLedgerTail(path, RECUT_LOOP_TAIL_BYTES);
      if (tail.state !== 'read') return [];
      writesText = tail.text;
      writesLowerBound = tail.truncated === true;
      writesWhole = tail.truncated !== true;
    }
    if (writesText === null) return [];
    const writeFold = foldRecutWriteJournal(writesText, nowMs, windowHours);

    // The jobs-ledger join is enrichment: withheld evidence degrades the
    // tallies to unknown, it never suppresses the journal recurrence.
    let jobs: Map<string, RecutJobTally> | null = null;
    let jobsLowerBound = false;
    if (opts.jobsText !== undefined) {
      jobs = opts.jobsText === null ? null : foldRecutJobOutcomes(opts.jobsText, nowMs, windowHours);
    } else {
      const path = opts.jobsPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
      const tail = await readLedgerTail(path, RECUT_LOOP_JOBS_TAIL_BYTES);
      if (tail.state === 'read') {
        jobs = foldRecutJobOutcomes(tail.text, nowMs, windowHours);
        jobsLowerBound = tail.truncated === true;
      }
    }

    const items: CloudBacklogItem[] = [];
    const cells = recutPrCells(writeFold, jobs, { lowerBound: writesLowerBound, jobsLowerBound });
    const limit = Math.max(1, Math.min(opts.limit ?? RECUT_LOOP_BACKLOG_MAX_ITEMS, RECUT_LOOP_BACKLOG_ITEM_HARD_MAX));
    for (const cell of cells) {
      if (items.length >= limit) break;
      items.push(recutItem(cell, repo));
    }

    // The reservation signal stands alone: it needs the lease journal and
    // a whole write tail — a truncated write journal could hide the
    // matching row and mint false orphans, so that case emits nothing
    // for this signal rather than suspect evidence.
    if (items.length < limit && writesWhole) {
      let leasesText: string | null;
      let leasesLowerBound = false;
      if (opts.leasesText !== undefined) {
        leasesText = opts.leasesText;
      } else {
        const path = opts.leasesPath ?? join(runsDir, 'queue', 'recut-loop-leases.jsonl');
        const tail = await readLedgerTail(path, RECUT_LOOP_TAIL_BYTES);
        if (tail.state === 'read') {
          leasesText = tail.text;
          leasesLowerBound = tail.truncated === true;
        } else {
          leasesText = null;
        }
      }
      if (leasesText !== null) {
        const leaseFold = foldRecutLeaseJournal(leasesText, nowMs, windowHours);
        const cell = recutLeaseCell(leaseFold.leases, writeFold.published, { nowMs, lowerBound: leasesLowerBound });
        if (cell !== null) items.push(leaseItem(cell, repo));
      }
    }
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
