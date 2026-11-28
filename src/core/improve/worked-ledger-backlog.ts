/**
 * ~/.ashlr/fleet/worked.json worked-ledger → self-improvement backlog items.
 *
 * The daemon's work queue keeps its own per-item scorecard in the worked
 * ledger (workedLedgerPath in src/core/fleet/worked-ledger.ts): every
 * selected WorkItem's terminal dispatch result lands as one bounded
 * {itemId, outcome, ts} event — 'diff' when the run produced a proposal,
 * 'empty' when it produced nothing, 'dispatch-blocked' when the item never
 * reached an executor — and the M220 judge-feedback sweep
 * (sweepJudgedProposals, run before each selection tick) feeds rejected
 * proposals back as 'judged-review', 'judged-noise' or 'judged-decline'.
 * The ledger is the anti-clog machinery's memory: recentlyDeclined,
 * workItemAttemptCapExceeded and proposalAlreadySwept all read it, bounded
 * to the newest ~2000 events under strict custody checks.
 *
 * Until now the ledger's only readers were those gates plus point-in-time
 * reports — fleet status's learning metrics, attempt coverage and fleet
 * feedback stats — so a fleet whose selected items kept yielding nothing,
 * whose launches kept blocking, or whose generated proposals kept dying at
 * the judge never became work. workedLedgerBacklogItems carries the same
 * events into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through loadWorkedLedgerDetailed's
 *    bounded, custody-checked, strictly-parsed read; nothing is written
 *    and no network is touched. A missing ledger is a clean empty source;
 *    a degraded or incomplete read yields the degraded-source item alone
 *    — never a fold over evidence the strict reader refused.
 *  - Degraded evidence is itself work. When the strict read reports
 *    'degraded' (unsafe-storage, unstable-read or invalid-ledger), every
 *    lenient consumer — loadWorkedLedger behind recentlyDeclined, the
 *    attempt-cap check and proposalAlreadySwept — fails fresh to an empty
 *    ledger on the same failure, so cooldown suppression and judge-sweep
 *    dedup are silently disarmed and the same items can be re-selected
 *    every tick. That state emits one item naming the recorded reasons.
 *  - Rows count only under the writer's contract: the strict parser has
 *    already enforced the six-outcome vocabulary, string itemId/ts and
 *    the 2000-event bound; the fold re-checks the same shape defensively
 *    because injected readers are not trusted, skips __swept_proposal__:
 *    marker rows as dedup bookkeeping (their proposalIds still count as
 *    swept-proposal evidence), and never guesses at malformed events.
 *  - Recurring means recorded across distinct items and days: a cell
 *    emits only at WORKED_LEDGER_MIN_ITEMS distinct itemIds across
 *    WORKED_LEDGER_MIN_DAYS distinct UTC days inside the window, so one
 *    unlucky item and one bad day never queue a session. 'diff' is the
 *    healthy outcome — it accumulates for prompt context only and never
 *    becomes a cell.
 *  - The window anchors on each event's own ts inside
 *    WORKED_LEDGER_WINDOW_HOURS; events whose timestamp cannot be parsed
 *    are counted as undated and reported, never silently folded.
 *  - Fleet machinery only: the ledger describes this install's daemon
 *    work queue and carries no repository column, so items emit only
 *    when the backlog target's repository name is 'phantom' — the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream: the item id hashes the cell identity (the
 *    outcome class or the degraded marker — never counts or timestamps),
 *    so a refresh re-derives the same id and a recovered cell simply
 *    stops re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  isWorkedOutcome,
  loadWorkedLedgerDetailed,
  type WorkedEvent,
  type WorkedLedgerReadResult,
  type WorkedLedgerSourceQuality,
  type WorkedOutcome,
} from '../fleet/worked-ledger.js';

/** Items one call may emit; the cell space is five outcome classes plus the degraded marker. */
export const WORKED_LEDGER_BACKLOG_MAX_ITEMS = 6;
const WORKED_LEDGER_BACKLOG_ITEM_HARD_MAX = 12;
/** A cell emits only at this many distinct item ids inside the window... */
export const WORKED_LEDGER_MIN_ITEMS = 3;
/** ...across at least this many distinct UTC days. */
export const WORKED_LEDGER_MIN_DAYS = 2;
/** Evidence window: the sibling fleet-evidence convention. */
export const WORKED_LEDGER_WINDOW_HOURS = 168;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: worked-ledger evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's own replay-text bound; longer ids are not contract evidence. */
const MAX_ITEM_ID_CHARS = 240;
/** Prompt-safe example ids: printable non-space ASCII, matching the bus-hoplog id shape. */
const SAFE_EXAMPLE_ID = /^[\x21-\x7e]{1,128}$/;
/** Swept-proposal dedup markers the judge-feedback sweep writes beside each item row. */
const SWEPT_MARKER_PREFIX = '__swept_proposal__:';
/** Example item ids quoted per cell inside one prompt. */
const MAX_EXAMPLE_ITEMS = 3;
/** The outcomes that represent the fleet producing no held work — 'diff' is the healthy contrast. */
export type AdverseWorkedOutcome = Exclude<WorkedOutcome, 'diff'>;
const ADVERSE_OUTCOMES: ReadonlySet<WorkedOutcome> = new Set<AdverseWorkedOutcome>([
  'empty',
  'dispatch-blocked',
  'judged-review',
  'judged-noise',
  'judged-decline',
]);

export interface WorkedLedgerItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Ledger read override (default: loadWorkedLedgerDetailed over ~/.ashlr/fleet/worked.json). */
  ledger?: () => WorkedLedgerReadResult;
  /** Evidence window in hours (default WORKED_LEDGER_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default WORKED_LEDGER_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

// ---------------------------------------------------------------------------
// Row contract — one WorkedEvent exactly as the writer appends it
// ---------------------------------------------------------------------------

interface WorkedRow {
  itemId: string;
  outcome: WorkedOutcome;
  tsMs: number;
  /** Present only on judge-sweep rows; bounded like the writer's own text fields. */
  proposalId: string | null;
  /** True for __swept_proposal__ dedup markers — bookkeeping, not an item outcome. */
  marker: boolean;
}

/**
 * Structural validation of one persisted event against the writer's
 * contract: a bounded itemId, the closed outcome vocabulary and a
 * parseable timestamp. proposalId is carried when the row records one.
 * Returns null for a corrupted or foreign event so the caller counts it
 * undated/skipped rather than let damaged evidence masquerade as a real
 * outcome. The strict parser already enforced this shape; the fold
 * re-checks because injected readers are not trusted.
 */
function projectEvent(event: WorkedEvent): WorkedRow | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  const itemId = event.itemId;
  if (!boundedString(itemId, MAX_ITEM_ID_CHARS)) return null;
  if (!isWorkedOutcome(event.outcome)) return null;
  if (typeof event.ts !== 'string') return null;
  const tsMs = Date.parse(event.ts);
  if (!Number.isFinite(tsMs)) return null;
  const proposalId = typeof event.proposalId === 'string' && boundedString(event.proposalId, MAX_ITEM_ID_CHARS)
    ? event.proposalId
    : null;
  return { itemId, outcome: event.outcome, tsMs, proposalId, marker: itemId.startsWith(SWEPT_MARKER_PREFIX) };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the ledger's retained events
// ---------------------------------------------------------------------------

interface OutcomeAccum {
  outcome: WorkedOutcome;
  rows: number;
  itemIds: Set<string>;
  proposalIds: Set<string>;
  days: Set<string>;
  examples: string[];
  firstMs: number | null;
  lastMs: number | null;
}

export interface WorkedLedgerFold {
  /** Per-outcome accumulators for contract-valid in-window events ('diff' included for context). */
  outcomes: Map<WorkedOutcome, OutcomeAccum>;
  /** Distinct proposal ids the in-window sweep markers named, per marker outcome (judge-feedback dedup evidence). */
  sweptProposals: Map<WorkedOutcome, Set<string>>;
  /** Contract-valid events skipped because their timestamp could not be parsed. */
  undated: number;
  /** In-window __swept_proposal__ marker rows excluded as dedup bookkeeping. */
  markers: number;
}

function accumFor(fold: WorkedLedgerFold, outcome: WorkedOutcome): OutcomeAccum {
  let accum = fold.outcomes.get(outcome);
  if (accum === undefined) {
    accum = { outcome, rows: 0, itemIds: new Set(), proposalIds: new Set(), days: new Set(), examples: [], firstMs: null, lastMs: null };
    fold.outcomes.set(outcome, accum);
  }
  return accum;
}

/**
 * Pure: fold worked-ledger events — oldest first — into per-outcome
 * evidence inside [nowMs - windowMs, nowMs]. Events outside the window
 * are normal aging and count nowhere; events whose timestamp cannot be
 * parsed are counted undated, never guessed. Marker rows contribute
 * their proposalId to sweptProposals and nothing else.
 */
export function foldWorkedLedger(events: readonly WorkedEvent[], nowMs: number, windowMs: number): WorkedLedgerFold {
  const fold: WorkedLedgerFold = { outcomes: new Map(), sweptProposals: new Map(), undated: 0, markers: 0 };
  for (const event of events) {
    const row = projectEvent(event);
    if (row === null) { fold.undated++; continue; }
    if (row.tsMs > nowMs || row.tsMs < nowMs - windowMs) continue;
    if (row.marker) {
      fold.markers++;
      if (row.proposalId !== null) {
        let ids = fold.sweptProposals.get(row.outcome);
        if (ids === undefined) { ids = new Set(); fold.sweptProposals.set(row.outcome, ids); }
        ids.add(row.proposalId);
      }
      continue;
    }
    const accum = accumFor(fold, row.outcome);
    accum.rows += 1;
    accum.itemIds.add(row.itemId);
    if (row.proposalId !== null) accum.proposalIds.add(row.proposalId);
    accum.days.add(dayOf(row.tsMs));
    if (SAFE_EXAMPLE_ID.test(row.itemId)
        && accum.examples.length < MAX_EXAMPLE_ITEMS && !accum.examples.includes(row.itemId)) {
      accum.examples.push(row.itemId);
    }
    accum.firstMs = accum.firstMs === null ? row.tsMs : Math.min(accum.firstMs, row.tsMs);
    accum.lastMs = accum.lastMs === null ? row.tsMs : Math.max(accum.lastMs, row.tsMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** One recurring adverse-outcome cell: an outcome class across distinct items and days. */
export interface WorkedLedgerCell {
  outcome: AdverseWorkedOutcome;
  /** Contract-valid in-window rows carrying this outcome. */
  rows: number;
  /** Distinct item ids — the recurring measure. */
  items: number;
  /** Distinct proposal ids recorded on the rows (0 when none carried one — unknown, not zero proposals). */
  proposals: number;
  /** Distinct UTC days the rows span inside the window. */
  days: number;
  /** Up to MAX_EXAMPLE_ITEMS prompt-safe item ids. */
  examples: string[];
  /** Distinct proposal ids the in-window sweep markers named for this outcome (0 when none — unknown, not zero rejections). */
  sweptProposals: number;
  /** Up to MAX_EXAMPLE_ITEMS prompt-safe swept proposal ids for this outcome. */
  sweptExamples: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Pure: the recurring bars one cell must clear — distinct items across
 * distinct UTC days, the fleet's RECURRING_FAILURES convention applied
 * to per-item yield. 'diff' never cells; it is the healthy contrast the
 * prompts quote. At most one cell exists per adverse outcome.
 */
export function workedLedgerCells(fold: WorkedLedgerFold): WorkedLedgerCell[] {
  const cells: WorkedLedgerCell[] = [];
  for (const accum of fold.outcomes.values()) {
    if (!ADVERSE_OUTCOMES.has(accum.outcome)) continue;
    if (accum.itemIds.size < WORKED_LEDGER_MIN_ITEMS || accum.days.size < WORKED_LEDGER_MIN_DAYS) continue;
    const swept = fold.sweptProposals.get(accum.outcome);
    cells.push({
      outcome: accum.outcome as AdverseWorkedOutcome,
      rows: accum.rows,
      items: accum.itemIds.size,
      proposals: accum.proposalIds.size,
      days: accum.days.size,
      examples: accum.examples,
      sweptProposals: swept?.size ?? 0,
      sweptExamples: [...(swept ?? [])].filter((id) => SAFE_EXAMPLE_ID.test(id)).slice(0, MAX_EXAMPLE_ITEMS),
      firstSeen: isoOrNull(accum.firstMs),
      lastSeen: isoOrNull(accum.lastMs),
    });
  }
  return cells.sort((a, b) => b.items - a.items || a.outcome.localeCompare(b.outcome));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/fleet/worked.json — workedLedgerPath in src/core/fleet/worked-ledger.ts resolves it under the user\'s home — the daemon work queue\'s per-item outcome ledger: recordOutcome appends {itemId, outcome, ts} events (proposalId on judge-sweep rows), bounded to the newest ~2000 events under strict custody checks, and sweepJudgedProposals feeds rejected proposals back as judged-review/judged-noise/judged-decline before each selection tick. Until now the ledger\'s readers were point-in-time: the cooldown and attempt-cap checks in src/core/daemon/loop.ts plus fleet status\'s learning metrics and fleet feedback stats — gates and reports, never work — so a fleet whose selected items kept yielding nothing, whose launches kept blocking, or whose proposals kept dying at the judge never became improvement work.';

const REPRO = (outcome: WorkedOutcome): string =>
  `Reproduce the fold by reading ~/.ashlr/fleet/worked.json and keeping events whose outcome is '${outcome}' with a parseable ts inside the last ${WORKED_LEDGER_WINDOW_HOURS} hours, then counting distinct itemId values across distinct UTC days. The writer, verdict mapping and sweep are recordOutcome, recordVerdict, sweepJudgedProposals and verdictToOutcome in src/core/fleet/worked-ledger.ts; the selection-side consumer is the daemon tick's cooldown policy in src/core/daemon/loop.ts.`;

const NO_CHANGE = 'If the window has rolled forward the outcomes were a transient burst that has since stopped, the fleet\'s item mix legitimately shifted (a campaign of already-done scanner items draining, a deliberate low-activity period), the judge verdicts trace to owner-only causes (a policy change or repository state the fleet cannot fix), or the ledger was rotated — report no-change and name the evidence.';

const OUTCOME_TEXT: Record<AdverseWorkedOutcome, { what: string; meaning: string; hunt: string; title: string }> = {
  'empty': {
    what: 'ran its dispatch and produced no proposal',
    meaning: 'the daemon selected the item, an executor ran, and the run yielded no proposal — either the work was already done, the pick was stale, or the dispatch produced an empty diff',
    hunt: 'whether the same items keep being re-selected after producing nothing (dedup or cooldown gaps), whether scanners keep minting already-done work, and whether empty-diff dispatches should feed a different outcome class or item shape',
    title: "Daemon work items keep finishing with no proposal ('empty')",
  },
  'dispatch-blocked': {
    what: 'was selected but never reached an executor',
    meaning: 'the work item cleared selection and then failed before launch — capacity, routing or launch-path evidence the outcome row itself does not carry',
    hunt: 'which stage blocks the launches (dispatch-production reasons, lane capacity, route availability), whether the same lanes or item sources recur, and whether blocked items should age out of selection instead of retrying',
    title: "Selected work items keep failing to reach an executor ('dispatch-blocked')",
  },
  'judged-review': {
    what: 'had its proposal judged \'review\' — escalated to a human',
    meaning: 'the judge declined to ship or reject outright and punted to operator review; recurring punts are review-queue load the fleet generates for itself',
    hunt: 'whether the same proposal shapes keep escalating (judge threshold versus proposal quality), whether review-punted items should feed a different proposal class, and whether the needs-you surface is absorbing recurring fleet-generated reviews',
    title: "Generated proposals keep escalating to human review ('judged-review')",
  },
  'judged-noise': {
    what: 'had its proposal judged noise/trivial',
    meaning: 'the judge rejected the proposal as not worth landing — recurring noise verdicts mean generation keeps producing trivial work',
    hunt: 'which item sources produce the noise (scanner templates, generated repairs), whether proposal prompts should carry the rejection evidence back to generation, and whether the judge\'s noise bar matches what the fleet considers worth a session',
    title: "Generated proposals keep being judged noise ('judged-noise')",
  },
  'judged-decline': {
    what: 'had its proposal judge-declined (harmful/rejected)',
    meaning: 'the judge rejected the proposal as harmful or decline-class — the strongest adverse verdict the feedback sweep records',
    hunt: 'what the declined proposals had in common (scope, files, risk class), whether generation prompts need the decline evidence, and whether judge calibration agrees these were correct rejections',
    title: "Generated proposals keep being judge-declined ('judged-decline')",
  },
};

function daySpanText(days: number): string {
  return `${days} distinct UTC day(s)`;
}

function seenText(cell: WorkedLedgerCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function examplesText(cell: WorkedLedgerCell): string {
  return cell.examples.length === 0 ? '' : ` Example item ids: ${cell.examples.join(', ')}.`;
}

/** In-window tally across every outcome — the honest yield contrast each prompt quotes. */
function tallyText(fold: WorkedLedgerFold, cell: WorkedLedgerCell): string {
  const parts: string[] = [];
  for (const accum of [...fold.outcomes.values()].sort((a, b) => b.rows - a.rows || a.outcome.localeCompare(b.outcome))) {
    parts.push(`${accum.rows} '${accum.outcome}'`);
  }
  const undatedText = fold.undated > 0 ? ` ${fold.undated} event(s) carried no parseable timestamp and could not be placed in the window.` : '';
  const markerText = fold.markers > 0 ? ` ${fold.markers} swept-proposal marker row(s) were excluded as dedup bookkeeping.` : '';
  return ` Across all outcomes in the window the ledger recorded ${parts.length === 0 ? 'no contract-valid events' : parts.join(', ')}; this cell covers ${cell.rows} row(s) on ${cell.items} distinct item(s) across ${daySpanText(cell.days)}.${undatedText}${markerText}`;
}

function sweptText(cell: WorkedLedgerCell): string {
  if (cell.sweptProposals === 0) return '';
  const examples = cell.sweptExamples.length > 0 ? ` (e.g. ${cell.sweptExamples.join(', ')})` : '';
  return ` The judge-feedback sweep's dedup markers name ${cell.sweptProposals} distinct rejected proposal id(s) for this outcome in the window${examples}.`;
}

function outcomePrompt(cell: WorkedLedgerCell, fold: WorkedLedgerFold): string {
  const text = OUTCOME_TEXT[cell.outcome];
  const proposalText = cell.proposals > 0
    ? ` ${cell.proposals} distinct proposal id(s) were recorded on these rows.`
    : '';
  return [
    `Phantom's daemon work queue keeps recording '${cell.outcome}' outcomes on its own selected backlog items — the self-improvement work this backlog exists for.`,
    '',
    `${cell.items} distinct item(s) across ${daySpanText(cell.days)} ${text.what} inside the window (${cell.rows} recorded '${cell.outcome}' row(s)) — recurring per-item yield evidence, not a one-off.${seenText(cell)}${examplesText(cell)}${proposalText}${sweptText(cell)}`,
    '',
    tallyText(fold, cell),
    '',
    EVIDENCE,
    '',
    `Find why this outcome keeps recurring: ${text.hunt}. Each '${cell.outcome}' row means the item ${text.meaning}. Fix what lives here — for example selection dedup that keeps re-picking items already proven empty, dispatch-path evidence readers that name the blocking stage, or proposal-generation prompts that carry the judge's rejection evidence back to the source — not the symptom.`,
    '',
    NO_CHANGE,
    '',
    REPRO(cell.outcome),
  ].join('\n');
}

function outcomeItem(cell: WorkedLedgerCell, fold: WorkedLedgerFold, repo: string): CloudBacklogItem {
  const outcome = cell.outcome;
  return {
    id: `fleet-worked-${sha(`worked-outcome:${outcome}`)}`,
    title: OUTCOME_TEXT[outcome].title.slice(0, MAX_TITLE_CHARS),
    prompt: outcomePrompt(cell, fold),
    area: 'worked-outcomes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

// ---------------------------------------------------------------------------
// Degraded-source item — the strict read itself failed
// ---------------------------------------------------------------------------

const DEGRADED_EVIDENCE = 'The evidence is ~/.ashlr/fleet/worked.json — workedLedgerPath in src/core/fleet/worked-ledger.ts resolves it under the user\'s home — read through loadWorkedLedgerDetailed, which requires a regular, owner-held file with no group/other write bits and a single link inside a safe ~/.ashlr/fleet directory, at most 2 MiB, parsing to {events: [...]} with at most 2000 rows under the closed outcome vocabulary. Every lenient consumer — loadWorkedLedger behind recentlyDeclined, workItemAttemptCapExceeded and sweepJudgedProposals\' proposalAlreadySwept — fails fresh to an empty ledger on the same failure.';

const DEGRADED_NO_CHANGE = 'If the file was mid-write during the read and now validates cleanly, or the fleet genuinely records no outcomes yet (a missing file reports \'missing\', never this item), report no-change and name the evidence.';

const DEGRADED_REPRO = 'Reproduce by calling loadWorkedLedgerDetailed() in src/core/fleet/worked-ledger.ts and reading sourceQuality.{sourceState,reasons,sourcePresent,bytesRead}; then lstat ~/.ashlr/fleet/worked.json and ~/.ashlr/fleet for the custody rules (regular file, owned by this user, mode & 022 === 0, nlink 1, at most 2097152 bytes).';

function degradedPrompt(quality: WorkedLedgerSourceQuality): string {
  const reasons = quality.reasons.length > 0 ? quality.reasons.join(', ') : 'none recorded';
  const present = quality.sourcePresent ? 'present' : 'absent';
  return [
    'Phantom\'s per-item worked ledger cannot be read intact — the self-improvement work this backlog exists for.',
    '',
    `At read time ~/.ashlr/fleet/worked.json reported sourceState 'degraded' (source ${present}, reasons: ${reasons}). The strict reader refused the file, and every lenient consumer fails fresh to an empty ledger on the same failure — so the daemon's anti-clog suppression is silently disarmed: items that should stay cooled down or parked can be re-selected and re-dispatched every tick, and judge-rejection dedup cannot see prior sweeps.`,
    '',
    DEGRADED_EVIDENCE,
    '',
    'Find which check fails: unsafe-storage (missing, linked, foreign-owned or permissive directory/file), unstable-read (the file changed mid-read or failed its identity re-check), or invalid-ledger (JSON outside the event contract or over 2000 events). Fix what lives here — for example a one-time ledger repair that rewrites the file under the custody contract, or reader tolerance for a legitimately larger history — not the symptom.',
    '',
    DEGRADED_NO_CHANGE,
    '',
    DEGRADED_REPRO,
  ].join('\n');
}

function degradedItem(quality: WorkedLedgerSourceQuality, repo: string): CloudBacklogItem {
  return {
    id: `fleet-worked-${sha('worked-ledger:degraded')}`,
    title: 'Worked outcome ledger is degraded — cooldown suppression reads empty'.slice(0, MAX_TITLE_CHARS),
    prompt: degradedPrompt(quality),
    area: 'worked-ledger',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the worked ledger's recurring per-item outcomes and
 * its degraded-source state. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function workedLedgerBacklogItems(opts: WorkedLedgerItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const read = (opts.ledger ?? loadWorkedLedgerDetailed)();
    const quality = read.sourceQuality;
    if (quality.sourceState === 'missing') return [];
    if (quality.sourceState !== 'healthy' || quality.complete !== true) {
      return [degradedItem(quality, repo)];
    }
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = (opts.windowHours ?? WORKED_LEDGER_WINDOW_HOURS) * 3_600_000;
    const fold = foldWorkedLedger(read.ledger.events, nowMs, windowMs);
    const cells = workedLedgerCells(fold);
    const limit = Math.max(1, Math.min(opts.limit ?? WORKED_LEDGER_BACKLOG_MAX_ITEMS, WORKED_LEDGER_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => outcomeItem(cell, fold, repo));
  } catch {
    return [];
  }
}
