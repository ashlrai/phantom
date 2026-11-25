/**
 * Selector pick outcomes → self-improvement backlog items.
 *
 * `phm select` — run hourly by the ai.ashlr.phm.selector launchd agent
 * (src/core/routing/selector-schedule.ts) — ranks the candidate pool
 * (selector/candidates.jsonl plus the friction ledger's top open items,
 * minted as RQ-FRICTION-<sha256-24> ids), prints the top --top picks as
 * READY lines for the planner to queue, appends one
 * {at, rank, id, repo, jobType, score, predictedValue, mergeRate, minutes,
 * usage, basis, frictionId?} row per funded pick to
 * <runs>/selector/picks.jsonl, and posts a selector.picks envelope
 * (from selector, to planner, one-hour TTL) to the local bus inbox
 * (src/cli/select.ts, src/core/routing/selector.ts pickRecords). The
 * pick id IS the READY-line id, which becomes the queue job id
 * metrics/jobs.jsonl records — so every prediction the selector makes
 * is joinable to the outcome it predicted.
 *
 * docs/contracts/CONTRACT-SELECTOR.md says predictedValue and mergeRate
 * are recorded "so a later run can compare it with the real outcome" —
 * and until now no run ever did. fundedIds reads picks.jsonl only to
 * dedupe re-funding; nothing folded the picks against the jobs ledger,
 * so a selector whose funded picks keep finishing empty, getting
 * precheck-declined, aborting, closing unmerged or never launching at
 * all looked identical to a healthy one. selectorPicksBacklogItems
 * carries the comparison into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. selector/picks.jsonl is read through readLedgerTail's
 *    bounded no-follow tail and metrics/jobs.jsonl through the same
 *    ROUTER_OUTCOME_LEDGER_LIMIT window the router outcome fold and the
 *    gap/recut feeds read; nothing is written and no network is
 *    touched. Missing or unreadable evidence on either side yields no
 *    items — the whole feed IS the outcome comparison, so a withheld
 *    jobs ledger means unknown, never a fabricated adverse cell.
 *  - Rows count only under the writer's contract: a pick row needs a
 *    parseable in-window `at` and a safe RQ-* `id` (the same shape
 *    parseCandidates enforces); malformed lines, undated or
 *    future-dated rows and unsafe ids are skipped, never guessed. The
 *    first recorded row per id wins — the writer's fundedIds dedupe
 *    means each id is funded at most once.
 *  - Recurring means recorded across days: an outcome class emits only
 *    at SELECTOR_PICK_MIN_PICKS distinct funded picks across
 *    SELECTOR_PICK_MIN_DAYS distinct UTC days inside the 7-day window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply.
 *    Each pick lands in exactly one class by recorded tallies, never by
 *    inference: merged beats every adverse class; then empty finishes,
 *    aborts, closed/other resolved outcomes, still-open activity,
 *    precheck-only declines.
 *  - 'never-launched' is the only absence claim, so it is the most
 *    guarded: the pick must be past the launch grace, the jobs tail
 *    must provably reach back to the funding time (its first dated
 *    retained row no newer than the pick's `at` — a truncated tail that
 *    starts later cannot prove a launch would have been kept), and the
 *    ledger must show the fleet launching other work in-window, so a
 *    fleet-wide stall never reads as a selector leak. Picks too fresh,
 *    outside coverage or with a quiet ledger fold to 'unknown' —
 *    counted in prompts, never cells.
 *  - Precheck declines are their own class: skipped_empty/precheck_skip
 *    rows mean the dispatcher's own gates refused the job before any
 *    launch — recorded evidence the funded scope had nothing to do,
 *    distinct from a launch that never happened.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository (the same last-segment rule the sibling
 *    fleet-evidence sources apply) — the selector, its schedule and
 *    the queue it feeds are this install's machinery. Picks for other
 *    repos still count toward the cells (the selector's hit rate is
 *    the evidence) and their repo tallies ride inside the prompt.
 *    Dedup is downstream: the item id hashes the class plus the
 *    repository — never the counts or timestamps — so a refresh
 *    re-derives the same id and a class that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, example pick ids must match the ledger's own id
 *    shape before they are quoted, jobType/basis/repo strings are
 *    scrubbed, flattened and capped, truncated tails are stated as
 *    lower bounds, and the brief names the journals, the writer and
 *    the handoff stages with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerPhase, ledgerPrUrl, ledgerStateTokens } from '../fleet/empty-cause.js';
import {
  isNodePoolLedgerRow,
  isPrecheckSkipRow,
  ledgerEventTs,
  ledgerJobId,
  ledgerLifecycleEvent,
  ledgerOutcomeState,
} from '../fleet/jobs-ledger-dialect.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the adverse-class set is small and closed. */
export const SELECTOR_PICKS_BACKLOG_MAX_ITEMS = 8;
const SELECTOR_PICKS_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const SELECTOR_PICKS_WINDOW_HOURS = 168;
/** An outcome class emits only at this many distinct funded picks inside the window... */
export const SELECTOR_PICK_MIN_PICKS = 3;
/** ...spread across at least this many distinct UTC days. */
export const SELECTOR_PICK_MIN_DAYS = 2;
/**
 * A funded pick with no jobs-ledger rows only reads 'never-launched'
 * once it is this old — READY→planner→queue→claim→launch is minutes on
 * a healthy fleet and the selector.picks bus envelope itself expires
 * after one hour, so a day-old pick with zero ledger rows is solid
 * evidence the funding pipeline dropped it.
 */
export const SELECTOR_PICK_LAUNCH_GRACE_MS = 24 * 3_600_000;
/**
 * Bounded tail of the append-only picks journal — the writer appends
 * every funded pick forever (up to --top per hourly run, ~250 bytes a
 * row), so 2 MiB retains months of picks; prompts state any truncation
 * as a lower bound.
 */
const SELECTOR_PICKS_TAIL_BYTES = 2 * 1024 * 1024;
/** The jobs ledger shares the router outcome fold's bounded tail. */
const SELECTOR_JOBS_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** The fleet's own repository label: selector evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Pick ids are the READY-line ids — the same RQ-* shape parseCandidates enforces. */
const SAFE_PICK_ID = /^RQ-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
/** The writer's recorded basis vocabulary (selector.ts SelectorPick['basis']). */
const PICK_BASES = new Set(['candidate', 'learned', 'default']);
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 120;
/** Example pick ids quoted inside one prompt. */
const MAX_PROMPT_EXAMPLES = 3;
/** Text tallies (jobType, basis, repo) quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface SelectorPicksItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding selector/picks.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default SELECTOR_PICKS_WINDOW_HOURS). */
  windowHours?: number;
  /** Picks journal override (default: <runsDir>/selector/picks.jsonl). */
  picksPath?: string;
  /** Jobs ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  jobsPath?: string;
  /** Injected picks-journal text (tests); skips the journal read when set — null means missing. */
  picksText?: string | null;
  /** Injected jobs-ledger text (tests); skips the ledger read when set — null means withheld. */
  jobsText?: string | null;
  /** Most items one call emits (default SELECTOR_PICKS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — the picks journal and the jobs-ledger outcome join
// ---------------------------------------------------------------------------

/** One validated funded pick inside the journal window. */
export interface SelectorPickRecord {
  /** The READY-line/job id the pick funded (RQ-*). */
  id: string;
  atMs: number;
  utcDay: string;
  /** Recorded target repo label, scrubbed and capped ('unrecorded' when absent). */
  repo: string;
  /** Recorded jobType ('unrecorded' when absent or off-shape). */
  jobType: string;
  /** Recorded estimate basis: candidate|learned|default, else 'unrecorded'. */
  basis: string;
  /** Recorded predictedValue, or null when the row carried none usable. */
  predictedValue: number | null;
  /** Recorded merge-rate prior, or null when the row carried none usable. */
  mergeRate: number | null;
  /** True when the pick carries a frictionId — a friction-ledger-sourced candidate. */
  friction: boolean;
}

export interface SelectorPicksFold {
  /** pick id → first recorded in-window row (the writer funds each id once). */
  picks: Map<string, SelectorPickRecord>;
  /** Non-blank lines that were not JSON objects. */
  malformed: number;
}

const recordedText = (value: unknown): string =>
  typeof value === 'string' && value.trim() !== '' ? fieldText(value, MAX_NAME_CHARS) || 'unrecorded' : 'unrecorded';

const recordedNum = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Pure: fold one picks-journal tail into per-id funded picks. Only rows
 * inside the window count; malformed lines, rows missing a usable `at`
 * or `id`, unsafe ids and off-window or future-dated rows are skipped,
 * never guessed. Extra fields the writer may grow are ignored for
 * forward compatibility.
 */
export function foldSelectorPicksJournal(text: string, nowMs: number, windowHours: number): SelectorPicksFold {
  const fold: SelectorPicksFold = { picks: new Map(), malformed: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { fold.malformed++; continue; }
    if (!isRecord(row)) { fold.malformed++; continue; }
    const id = row['id'];
    const at = row['at'];
    if (typeof id !== 'string' || !SAFE_PICK_ID.test(id)) continue;
    if (fold.picks.has(id)) continue;
    if (typeof at !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs) || atMs < since || atMs > until) continue;
    const basis = row['basis'];
    const frictionId = row['frictionId'];
    fold.picks.set(id, {
      id,
      atMs,
      utcDay: dayOf(atMs),
      repo: recordedText(row['repo']),
      jobType: recordedText(row['jobType']),
      basis: typeof basis === 'string' && PICK_BASES.has(basis) ? basis : 'unrecorded',
      predictedValue: recordedNum(row['predictedValue']),
      mergeRate: recordedNum(row['mergeRate']),
      friction: typeof frictionId === 'string' && frictionId.trim() !== '',
    });
  }
  return fold;
}

/** Recorded outcome tallies for one picked job inside the window — every count is ledger-recorded, never inferred. */
export interface SelectorJobTally {
  /** In-window ledger rows seen for the pick id (any event). */
  rows: number;
  launches: number;
  finishes: number;
  /** Finishes or publishes that ended the job with no change (empty:true, EMPTY_DONE, publish class 'empty'). */
  emptyFinishes: number;
  /** Publish rows claiming a PR (class 'pr' or carrying a PR url). */
  prs: number;
  /** Publish rows whose class starts with 'abort'. */
  aborts: number;
  /** Precheck/dupcheck gate declines (skipped_empty with a numeric code, precheck_skip) that never launched. */
  precheckSkips: number;
  /** Resolved outcome states: MERGED verdicts, CLOSED verdicts and every other resolved phase. */
  merged: number;
  closed: number;
  resolvedOther: number;
}

const emptyTally = (): SelectorJobTally => ({
  rows: 0, launches: 0, finishes: 0, emptyFinishes: 0, prs: 0, aborts: 0, precheckSkips: 0, merged: 0, closed: 0, resolvedOther: 0,
});

export interface SelectorJobsFold {
  /** pick id → recorded outcome tallies (absent when the ledger holds no in-window rows for the id). */
  tallies: Map<string, SelectorJobTally>;
  /** 'launch' lifecycle events across ALL in-window jobs-ledger rows — the fleet-is-dispatching guard. */
  launchesInWindow: number;
  /**
   * Timestamp of the first dated row in the retained tail — the oldest
   * evidence the bounded read kept. A pick funded before it cannot be
   * proven never-launched: its launch rows may have been cut. Null when
   * no retained row carried a parseable timestamp.
   */
  coverageStartMs: number | null;
}

/**
 * Pure: fold one jobs-ledger tail into per-pick outcome tallies plus the
 * fleet-wide launch count and coverage boundary the never-launched class
 * needs. Only rows for `pickIds` join tallies; node-pool producer
 * schemas, malformed lines, unsafe job ids and undated rows are skipped,
 * never guessed. `coverageStartMs` records the first dated row seen in
 * tail order regardless of the window — retained bytes, not verdicts.
 */
export function foldSelectorJobOutcomes(
  text: string,
  nowMs: number,
  windowHours: number,
  pickIds: ReadonlySet<string>,
): SelectorJobsFold {
  const fold: SelectorJobsFold = { tallies: new Map(), launchesInWindow: 0, coverageStartMs: null };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row)) continue;
    if (isNodePoolLedgerRow(row)) continue;
    const phase = ledgerPhase(row);
    const atMs = ledgerEventTs(row, phase);
    if (atMs !== null && fold.coverageStartMs === null) fold.coverageStartMs = atMs;
    if (atMs === null || atMs < since || atMs > until) continue;
    const event = ledgerLifecycleEvent(row, phase);
    if (event === 'launch') fold.launchesInWindow += 1;
    const job = ledgerJobId(row);
    if (job === null || !pickIds.has(job)) continue;
    let tally = fold.tallies.get(job);
    if (tally === undefined) {
      tally = emptyTally();
      fold.tallies.set(job, tally);
    }
    tally.rows += 1;
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
    } else if (isPrecheckSkipRow(row)) {
      tally.precheckSkips += 1;
    }
    const state = ledgerOutcomeState(row, event, phase);
    if (state === 'MERGED') tally.merged += 1;
    else if (state === 'CLOSED') tally.closed += 1;
    else if (state !== null) tally.resolvedOther += 1;
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** The five adverse outcome classes that become work; the rest are context. */
export type SelectorPickClass = 'never-launched' | 'empty' | 'declined' | 'aborted' | 'unmerged';
/** Every class a pick can land in — the three non-adverse ones are prompt context only. */
export type SelectorPickOutcome = SelectorPickClass | 'merged' | 'open' | 'unknown';

const ADVERSE_CLASSES: ReadonlySet<SelectorPickOutcome> = new Set(['never-launched', 'empty', 'declined', 'aborted', 'unmerged']);

export interface SelectorPickTally {
  /** Sanitized recorded text (a jobType, basis or repo label). */
  text: string;
  count: number;
}

/** One emitted recurring outcome class: the pick fold plus the joined job tallies. */
export interface SelectorPickCell {
  cls: SelectorPickClass;
  /** Distinct funded picks in the class inside the window. */
  picks: number;
  /** Sorted distinct UTC days the picks landed on. */
  days: string[];
  /** Up to MAX_PROMPT_EXAMPLES pick ids, sorted — each already matched SAFE_PICK_ID. */
  examples: string[];
  /** Recorded jobType tallies, most frequent first. */
  jobTypes: SelectorPickTally[];
  /** Recorded basis tallies, most frequent first. */
  bases: SelectorPickTally[];
  /** Recorded repo tallies, most frequent first. */
  repos: SelectorPickTally[];
  /** How many picks carried a frictionId — friction-ledger-sourced candidates. */
  friction: number;
  /** ISO bounds of the class's picks; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the picks journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
  /** True when the jobs ledger's bounded tail was truncated: tallies are a lower bound. */
  jobsLowerBound: boolean;
}

/** Window-wide class counts quoted inside every prompt — the honest denominator. */
export interface SelectorPickWindowCounts {
  total: number;
  merged: number;
  open: number;
  unknown: number;
  /** Per-adverse-class pick counts (classes with zero picks are absent). */
  adverse: Map<SelectorPickClass, number>;
}

function tallyOf(map: Map<string, number>, max: number): SelectorPickTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Pure: the outcome class one funded pick lands in, from recorded
 * tallies only. A pick with no ledger rows is 'never-launched' only
 * when every guard holds — past the launch grace, the retained jobs
 * tail provably covers the funding time, and the fleet launched other
 * work in-window; anything less is 'unknown', never a guess.
 */
export function classifySelectorPick(
  pick: SelectorPickRecord,
  tally: SelectorJobTally | undefined,
  jobs: SelectorJobsFold,
  nowMs: number,
): SelectorPickOutcome {
  if (tally === undefined) {
    if (
      jobs.coverageStartMs !== null
      && pick.atMs >= jobs.coverageStartMs
      && pick.atMs <= nowMs - SELECTOR_PICK_LAUNCH_GRACE_MS
      && jobs.launchesInWindow > 0
    ) return 'never-launched';
    return 'unknown';
  }
  if (tally.merged > 0) return 'merged';
  if (tally.emptyFinishes > 0) return 'empty';
  if (tally.aborts > 0) return 'aborted';
  if (tally.closed > 0 || tally.resolvedOther > 0) return 'unmerged';
  if (tally.launches > 0 || tally.finishes > 0 || tally.prs > 0) return 'open';
  if (tally.precheckSkips > 0) return 'declined';
  return 'unknown';
}

/**
 * Pure: classify every in-window pick and keep the adverse classes that
 * meet the recurring bars. Sorted by pick count, busiest class first;
 * the window counts ride along so prompts quote the whole denominator.
 */
export function selectorPickCells(
  fold: SelectorPicksFold,
  jobs: SelectorJobsFold,
  nowMs: number,
  opts: { lowerBound?: boolean; jobsLowerBound?: boolean } = {},
): { cells: SelectorPickCell[]; window: SelectorPickWindowCounts } {
  interface Acc {
    ids: Set<string>;
    days: Set<string>;
    firstMs: number;
    lastMs: number;
    examples: string[];
    jobTypes: Map<string, number>;
    bases: Map<string, number>;
    repos: Map<string, number>;
    friction: number;
  }
  const newAcc = (): Acc => ({
    ids: new Set(), days: new Set(), firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY,
    examples: [], jobTypes: new Map(), bases: new Map(), repos: new Map(), friction: 0,
  });
  const adverse = new Map<SelectorPickClass, Acc>();
  const windowCounts: SelectorPickWindowCounts = { total: 0, merged: 0, open: 0, unknown: 0, adverse: new Map() };
  const bump = (map: Map<string, number>, key: string): void => { map.set(key, (map.get(key) ?? 0) + 1); };

  for (const pick of fold.picks.values()) {
    windowCounts.total += 1;
    const cls = classifySelectorPick(pick, jobs.tallies.get(pick.id), jobs, nowMs);
    if (!ADVERSE_CLASSES.has(cls)) {
      if (cls === 'merged') windowCounts.merged += 1;
      else if (cls === 'open') windowCounts.open += 1;
      else windowCounts.unknown += 1;
      continue;
    }
    const key = cls as SelectorPickClass;
    windowCounts.adverse.set(key, (windowCounts.adverse.get(key) ?? 0) + 1);
    let acc = adverse.get(key);
    if (acc === undefined) {
      acc = newAcc();
      adverse.set(key, acc);
    }
    acc.ids.add(pick.id);
    acc.days.add(pick.utcDay);
    acc.firstMs = Math.min(acc.firstMs, pick.atMs);
    acc.lastMs = Math.max(acc.lastMs, pick.atMs);
    if (acc.examples.length < MAX_PROMPT_EXAMPLES && !acc.examples.includes(pick.id)) acc.examples.push(pick.id);
    bump(acc.jobTypes, pick.jobType);
    bump(acc.bases, pick.basis);
    bump(acc.repos, pick.repo);
    if (pick.friction) acc.friction += 1;
  }

  const cells: SelectorPickCell[] = [];
  for (const [cls, acc] of adverse) {
    if (acc.ids.size < SELECTOR_PICK_MIN_PICKS || acc.days.size < SELECTOR_PICK_MIN_DAYS) continue;
    cells.push({
      cls,
      picks: acc.ids.size,
      days: [...acc.days].sort(),
      examples: [...acc.examples].sort(),
      jobTypes: tallyOf(acc.jobTypes, MAX_PROMPT_TALLIES),
      bases: tallyOf(acc.bases, MAX_PROMPT_TALLIES),
      repos: tallyOf(acc.repos, MAX_PROMPT_TALLIES),
      friction: acc.friction,
      firstSeen: isoOrNull(Number.isFinite(acc.firstMs) ? acc.firstMs : null),
      lastSeen: isoOrNull(Number.isFinite(acc.lastMs) ? acc.lastMs : null),
      lowerBound: opts.lowerBound === true,
      jobsLowerBound: opts.jobsLowerBound === true,
    });
  }
  cells.sort((a, b) => b.picks - a.picks || a.cls.localeCompare(b.cls));
  return { cells, window: windowCounts };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const WINDOW_DAYS = Math.round(SELECTOR_PICKS_WINDOW_HOURS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the picks\' jobs have since merged or are still legitimately in flight, the funded candidates were a one-off intake rather than a recurring source, or the cause is owner-only or pinned ops machinery (credentials, billing, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is selector/picks.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): `phm select` — hourly via the ai.ashlr.phm.selector launchd agent (src/core/routing/selector-schedule.ts) — appends one {at, rank, id, repo, jobType, score, predictedValue, mergeRate, minutes, usage, basis, frictionId?} row per funded pick through pickRecords (src/core/routing/selector.ts), where id is the READY-line id a planner queues and metrics/jobs.jsonl records as the job id. The outcome join reads metrics/jobs.jsonl through the same bounded tail `phm router outcomes`, the gap-proposal and recut-loop feeds use: launches, finishes (empty or not), PR publishes, aborts, precheck/dupcheck declines and resolved outcome states per pick id inside the same window. docs/contracts/CONTRACT-SELECTOR.md records predictedValue and mergeRate "so a later run can compare it with the real outcome" — this feed is that comparison; until now fundedIds was the journal\'s only reader.';

const truncationNote = (cell: SelectorPickCell): string =>
  [
    cell.lowerBound ? ' The picks journal tail was truncated at the bounded read, so pick counts cover only the retained bytes — a lower bound.' : '',
    cell.jobsLowerBound ? ' The jobs-ledger tail was truncated at the bounded read, so the outcome tallies cover only the retained window — a lower bound.' : '',
  ].filter((s) => s !== '').join('');

const tallyText = (tallies: readonly SelectorPickTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

/** The window denominator: every funded pick's recorded class, so the cell never reads as the whole story. */
function windowText(window: SelectorPickWindowCounts): string {
  const parts = [
    `${window.merged} merged/held`,
    `${window.open} still open`,
    `${window.unknown} not yet judgeable`,
  ];
  const adverse = [...window.adverse.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${n} ${cls}`);
  return ` Inside the same window the selector funded ${window.total} pick(s); the recorded classes were ${[...parts, ...adverse].join(', ')}.`;
}

const detailText = (cell: SelectorPickCell): string => {
  const parts: string[] = [];
  if (cell.examples.length > 0) parts.push(`Example pick id(s): ${cell.examples.join(', ')}.`);
  if (cell.jobTypes.length > 0) parts.push(`Recorded jobType(s): ${tallyText(cell.jobTypes)}.`);
  if (cell.bases.length > 0) parts.push(`Recorded basis: ${tallyText(cell.bases)}.`);
  if (cell.repos.length > 0) parts.push(`Recorded target repo(s): ${tallyText(cell.repos)}.`);
  if (cell.friction > 0) parts.push(`${cell.friction} of the ${cell.picks} pick(s) were friction-ledger-sourced (frictionId recorded).`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
};

interface ClassMeta {
  title: string;
  /** The opening claim sentence — what keeps happening. */
  lead: string;
  /** The diagnostic paragraph: where to look and what this repo owns. */
  diagnose: string;
}

const CLASS_META: Record<SelectorPickClass, ClassMeta> = {
  'never-launched': {
    title: 'Selector-funded picks keep never launching',
    lead: 'Phantom\'s standing selector keeps funding work that never becomes a job — picks are recorded, deduped forever, and silently retired without a launch.',
    diagnose: `Each row is a funded pick whose id never appears in metrics/jobs.jsonl past the ${Math.round(SELECTOR_PICK_LAUNCH_GRACE_MS / 3_600_000)}-hour launch grace while the fleet kept launching other work in-window — the READY line never became a job. Trace the handoff stage by stage: the selector.picks bus envelope (from selector, to planner, one-hour TTL) and the READY lines \`phm select\` prints to its log, whether the planner appended them to queue/router-queue.md, whether queue dedupe SUPERSEDED-BY'd a line against an existing id, and whether dispatchd claimed and launched what was queued. A pick that never launches also never spends — but fundedIds dedupes picks.jsonl forever, so every dropped pick permanently retires that candidate: a systematic leak silently shrinks the work pool the selector exists to fill. Fix the pipeline stage that drops them — the planner consumer, the queue import or the dispatch claim path — in this repository; if the cause is the planner's cadence or pinned ops machinery, report no-change and name the evidence.`,
  },
  empty: {
    title: 'Selector-funded picks keep finishing empty',
    lead: 'Phantom\'s standing selector keeps funding picks whose jobs launch and finish with no change — the predicted work was not there to do.',
    diagnose: 'Each pick\'s job launched and ended empty (empty:true, EMPTY_DONE or publish class \'empty\') with no merge recorded — the funded scope described work already done, already covered, or never present. Check what the pick ids\' jobs actually did — the \'phm jobs yield\' and \'phm jobs empty\' folds over metrics/jobs.jsonl, each job\'s own log — and where the candidates came from: selector/candidates.jsonl producers and the friction ledger\'s RQ-FRICTION-* minting (friction_id names the ledger item end to end). Recurring empty finishes mean the candidate pool or the friction ledger is minting phantom work, or the selector\'s value/leverage estimates fund scopes whose acceptance is already satisfied; fix the intake or the scoring inputs in this repository, not the symptom. If the empties were legitimate already-done discoveries — report no-change and name the evidence.',
  },
  declined: {
    title: 'Selector-funded picks keep getting precheck-declined',
    lead: 'Phantom\'s standing selector keeps funding picks the dispatcher\'s own precheck gates refuse before any launch — the queue says there was nothing to do.',
    diagnose: 'Each pick\'s job recorded only precheck/dupcheck decline rows (skipped_empty with a numeric code, precheck_skip) and never launched — the empty-run or dupcheck gate finished the job DONE-NOOP, meaning the work was already done, already queued or the spec was rejected before spend. Check queue/precheck-skips.tsv and the \'phm fleet precheck-repeats\' fold for the recorded codes and reasons, then trace whether the selector\'s candidates duplicate work the queue already knows (the friction ledger items may already be queued under another id) or whether the gate rule itself misfires on selector-shaped specs. Fix the candidate intake, the dedupe the selector skips, or the gate rule in this repository; if the declines are correct refusals of genuinely stale candidates — report no-change and name the evidence.',
  },
  aborted: {
    title: 'Selector-funded picks keep aborting',
    lead: 'Phantom\'s standing selector keeps funding picks whose attempts abort before producing a verdict — quota, lane or launcher failures burn the funding.',
    diagnose: 'Each pick\'s job recorded publish rows with class \'abort*\' and no merge — the attempt died before a finish or outcome (quota exhaustion, lane auth, launcher failure, wall-clock kill). Check the abort classes recorded on those publish rows, the lane and pool the picks carried, and whether sibling fleet feeds (lost-launch, launch-cost, rate-limit) already name the same machinery — a selector-specific angle is whether the ranking keeps re-funding jobTypes/pools that cannot run on this fleet. Fix what this repository owns — candidate pool/lane hints, the selector\'s pool/tier passthrough, or the abort evidence itself; if the aborts are pinned ops machinery or owner-only (credentials, billing, host state) — report no-change and name the evidence.',
  },
  unmerged: {
    title: 'Selector-funded picks keep closing unmerged',
    lead: 'Phantom\'s standing selector keeps funding picks whose jobs resolve without a merge — work was attempted and did not hold.',
    diagnose: 'Each pick\'s job recorded a CLOSED or other non-merge resolved outcome and no MERGED verdict — a PR may have opened and closed, or the job resolved to a terminal non-merge state. Check the resolved phases and PR urls the jobs ledger recorded for the example ids, whether the work was superseded, rejected in review or closed as already-landed, and whether the selector\'s predictedValue/mergeRate priors are funding jobTypes whose realized hold rate is worse than the smoothed prior assumes. The outcome-learning cells the selector reads are the same fold \'phm fleet outcomes\' prints — if the priors are stale or the candidates systematically pick work that cannot hold, fix the scoring inputs or the candidate source in this repository; if the closures were correct verdicts on one-off work — report no-change and name the evidence.',
  },
};

function selectorPickPrompt(cell: SelectorPickCell, window: SelectorPickWindowCounts, repo: string): string {
  const meta = CLASS_META[cell.cls];
  const first = cell.firstSeen === null ? null : Date.parse(cell.firstSeen);
  const last = cell.lastSeen === null ? null : Date.parse(cell.lastSeen);
  const span = first !== null && last !== null ? ` (${daySpan(first, last)}-day span, first ${cell.firstSeen}, last ${cell.lastSeen})` : '';
  return [
    `${meta.lead} ${cell.picks} funded pick(s) landed in this class inside the ${WINDOW_DAYS}-day window on ${repo}, the self-improvement work this backlog exists for.`,
    '',
    `The picks journal recorded ${cell.picks} distinct pick id(s) in this class across ${cell.days.length} UTC day(s) (${daysText(cell.days)})${span}.${detailText(cell)}${windowText(window)}${truncationNote(cell)}`,
    '',
    EVIDENCE,
    '',
    meta.diagnose,
    '',
    `Run the affected suite (test/routing-selector.test.ts, test/improve-selector-picks-backlog.test.ts). ${NO_CHANGE}`,
  ].join('\n');
}

function selectorPickItem(cell: SelectorPickCell, window: SelectorPickWindowCounts, repo: string): CloudBacklogItem {
  return {
    id: `selector-picks-${cell.cls}-${sha(`selector-picks:${cell.cls}:${repo.toLowerCase()}`)}`,
    title: `${CLASS_META[cell.cls].title} on ${repo}`.slice(0, MAX_TITLE_CHARS),
    prompt: selectorPickPrompt(cell, window, repo),
    area: 'selector-picks',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the selector picks journal's recurring adverse
 * outcome classes. Total: any read or fold failure yields no items
 * rather than throwing into discovery — and a withheld jobs ledger
 * yields none either, since the feed IS the outcome comparison.
 */
export async function selectorPicksBacklogItems(opts: SelectorPicksItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? SELECTOR_PICKS_WINDOW_HOURS;

    // The picks journal is the primary evidence: missing or unreadable
    // means there is nothing funded to compare — never a fabricated cell.
    let picksText: string | null;
    let picksLowerBound = false;
    if (opts.picksText !== undefined) {
      picksText = opts.picksText;
    } else {
      const path = opts.picksPath ?? join(runsDir, 'selector', 'picks.jsonl');
      const tail = await readLedgerTail(path, SELECTOR_PICKS_TAIL_BYTES);
      if (tail.state !== 'read') return [];
      picksText = tail.text;
      picksLowerBound = tail.truncated === true;
    }
    if (picksText === null) return [];
    const pickFold = foldSelectorPicksJournal(picksText, nowMs, windowHours);
    if (pickFold.picks.size === 0) return [];

    // The jobs ledger is not enrichment here — it IS the evidence. A
    // withheld or unreadable ledger leaves every pick 'unknown', so the
    // source stays quiet rather than emitting cells it cannot prove.
    let jobsFold: SelectorJobsFold | null = null;
    let jobsLowerBound = false;
    if (opts.jobsText !== undefined) {
      if (opts.jobsText !== null) {
        jobsFold = foldSelectorJobOutcomes(opts.jobsText, nowMs, windowHours, new Set(pickFold.picks.keys()));
      }
    } else {
      const path = opts.jobsPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
      const tail = await readLedgerTail(path, SELECTOR_JOBS_TAIL_BYTES);
      if (tail.state === 'read') {
        jobsFold = foldSelectorJobOutcomes(tail.text, nowMs, windowHours, new Set(pickFold.picks.keys()));
        jobsLowerBound = tail.truncated === true;
      }
    }
    if (jobsFold === null) return [];

    const { cells, window } = selectorPickCells(pickFold, jobsFold, nowMs, {
      lowerBound: picksLowerBound,
      jobsLowerBound,
    });
    const limit = Math.max(1, Math.min(opts.limit ?? SELECTOR_PICKS_BACKLOG_MAX_ITEMS, SELECTOR_PICKS_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => selectorPickItem(cell, window, repo));
  } catch {
    return [];
  }
}
