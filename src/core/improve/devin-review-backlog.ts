/**
 * ~/.ashlr/devin/pr-reviews.jsonl Devin PR-review trigger journal →
 * self-improvement backlog items.
 *
 * Every Devin PR-review trigger attempt — `ashlr devin review`
 * (origin 'cli', src/cli/devin.ts) and the merge autopilot's advisory
 * review gate (origin 'fleet', fleetDevinReview in
 * src/core/fleet/merge-autopilot.ts) — runs triggerDevinPrReviewOnce
 * (src/core/devin/pr-review.ts), which appends one row per outcome to
 * this single append-only file under devinHome():
 *
 *   {v:1, key, repo, number, headSha, at, day, origin, outcome,
 *    reason?, status?}
 *
 * key is `${repo}#${number}@${headSha}` lowercased; outcome is the
 * writer's closed vocabulary — 'requested' once the daily-cap and
 * dedupe gates pass (always paired with exactly one terminal row
 * carrying the same `at`, since the writer captures `now` once per
 * call), then 'triggered' on an accepted API call, 'failed' on a
 * non-quota API error and 'quota-exhausted' on a quota/billing
 * refusal. Refusals (disabled, duplicate, daily-cap, missing-auth,
 * unknown-plan, quota-exhausted-by-capacity, request-failed)
 * journal nothing — the file records attempts, not gate decisions.
 *
 * Until now the journal's only readers were the writer's own dedupe
 * scan (journalRows inside triggerDevinPrReviewOnce and the
 * fleetDevinReview duplicate check): a point-in-time read that answers
 * "have we already asked for this head" and never folds a recurrence.
 * A review path whose API calls keep failing, whose provider quota
 * keeps exhausting, or whose process keeps dying between the
 * 'requested' append and its outcome append looked like isolated rows,
 * never a pattern, never work — and each orphaned 'requested' row
 * permanently dedupes its PR head ('duplicate' refusals forever).
 * devinReviewBacklogItems carries the journal into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail at the writer's own read bound
 *    (PR_REVIEW_JOURNAL_MAX_BYTES); nothing is written and no lock,
 *    process or network is touched. A missing or unreadable file
 *    yields no items; a malformed line is skipped, never guessed.
 *  - Rows count only under the writer's contract: v === 1, the
 *    repo#number@headSha key shape bounds, the owner/name repo
 *    pattern parseDevinPrRef enforces, a safe-integer PR number, the
 *    40-64 hex headSha the writer validates before appending, a
 *    parseable `at`, bounded day/origin/outcome vocabulary, and
 *    reason/status as the bounded strings the writer records. Malformed
 *    lines and off-contract rows are counted, never guessed.
 *  - Adverse only: 'triggered' rows and resolved 'requested' rows are
 *    the healthy path and never form cells. Cells are per-outcome —
 *    'failed' API errors, 'quota-exhausted' provider refusals, and
 *    'orphaned' requests (a 'requested' row whose key has no terminal
 *    sibling among the parsed rows and whose `at` is older than
 *    DEVIN_REVIEW_ORPHAN_STALE_MS — the writer died or the append was
 *    lost mid-flight, and the row now refuses 'duplicate' forever).
 *    A still-in-flight request is not yet orphaned.
 *  - Recurring means distinct and across days: a cell emits only when
 *    its in-window rows reach DEVIN_REVIEW_MIN_ROWS across
 *    DEVIN_REVIEW_MIN_DAYS distinct UTC days AND
 *    DEVIN_REVIEW_MIN_PRS distinct pull requests inside the 7-day
 *    window — one stubborn PR retried is a bad review target, not a
 *    broken trigger path.
 *  - Repo attribution is exact owner/name, case-insensitive: the
 *    journal's repo field is the reviewed pull request's repository
 *    and the fold keeps only rows naming the discovery target —
 *    reviews of another repository's pull requests are that repo's
 *    evidence, not this one's.
 *  - Oversize is stated, never hidden: the file has no rotation, and
 *    past PR_REVIEW_JOURNAL_MAX_BYTES the writer's own journalRows
 *    read refuses — every trigger fails 'request-failed'/'unavailable'
 *    and fleetDevinReview reports 'refused' forever. readLedgerTail's
 *    truncated flag is exactly that condition (its bound IS the
 *    writer's bound), so an oversize journal emits its own item for
 *    the fleet's own repository — the journal describes this install's
 *    Devin integration and carries no single-repo attribution for the
 *    file-level condition.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older bytes the counts are a lower bound — though at this bound
 *    truncation also means the oversize item above.
 *  - Dedup is downstream. The item id hashes the cell identity
 *    (kind + repo — never the counts or timestamps), so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only what
 *    is new; a cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, journal strings are scrubbed, flattened
 *    and capped before they are quoted, and the brief carries the
 *    usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { devinHome, PR_REVIEW_JOURNAL_MAX_BYTES } from '../devin/store.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is three outcomes plus oversize. */
export const DEVIN_REVIEW_BACKLOG_MAX_ITEMS = 6;
const DEVIN_REVIEW_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const DEVIN_REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const DEVIN_REVIEW_FUTURE_SKEW_MS = 60_000;
/** Adverse rows a cell needs inside the window before its recurrence counts. */
export const DEVIN_REVIEW_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const DEVIN_REVIEW_MIN_DAYS = 2;
/** Distinct pull requests those rows must name — one stubborn PR is not a broken path. */
export const DEVIN_REVIEW_MIN_PRS = 2;
/**
 * A 'requested' row younger than this may still be in flight — the API
 * call resolves in seconds and the outcome row lands right behind it.
 * Past it, a request with no terminal sibling is an orphan: the writer
 * died or the append was lost mid-flight and the key refuses 'duplicate'
 * forever.
 */
export const DEVIN_REVIEW_ORPHAN_STALE_MS = 60 * 60 * 1000;
/** The fleet's own repository label: oversize evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Reason labels quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example PR references quoted inside one prompt. */
const MAX_EXAMPLES = 3;

/** The adverse cell kinds the fold emits; 'requested'/'triggered' are valid but not evidence. */
export type DevinReviewCellKind = 'failed' | 'quota-exhausted' | 'orphaned-request';

/** One validated journal row. */
export interface DevinReviewRow {
  atMs: number;
  utcDay: string;
  /** The reviewed pull request's repository, owner/name as recorded. */
  repo: string;
  repoKey: string;
  /** The pull request number. */
  number: number;
  /** `${repo}#${number}@${headSha}` lowercased — the writer's dedupe identity. */
  key: string;
  origin: 'fleet' | 'cli';
  outcome: 'requested' | 'triggered' | 'failed' | 'quota-exhausted';
  /** The recorded failure code or review status vocabulary label, or null. */
  reason: string | null;
  status: string | null;
}

export interface DevinReviewItemsOptions {
  /** Backlog target in owner/name form; cells emit only for rows whose repo names it. */
  repo: string;
  /** Journal override (default: join(devinHome(), 'pr-reviews.jsonl') — the writer's own path). */
  journalPath?: string;
  /** Most items one call emits (default DEVIN_REVIEW_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default DEVIN_REVIEW_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window and the orphan staleness bound (default: now). */
  now?: Date;
}

const REPO_LABEL = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA = /^[a-fA-F0-9]{40,64}$/;
const ORIGINS = new Set(['fleet', 'cli']);
const OUTCOMES = new Set(['requested', 'triggered', 'failed', 'quota-exhausted']);
/** Terminal outcomes: a 'requested' row is resolved exactly when its key has one of these. */
const TERMINAL_OUTCOMES = new Set(['triggered', 'failed', 'quota-exhausted']);
/** parseDevinPrReview's closed review-status vocabulary — the only values a 'triggered' row's status can carry. */
const REVIEW_STATUSES = new Set(['pending', 'running', 'completed', 'errored', 'cancelled', 'skipped']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bounded no-control text: the writer's identity fields never carry control characters. */
function boundedText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: validate one parsed journal line against the writer's record
 * contract — every field triggerDevinPrReviewOnce's row() emits plus
 * the identity, vocabulary and pairing requirements the dedupe and
 * daily-cap scans rely on. Anything else is not a journal row.
 */
export function parseDevinReviewJournalEntry(value: unknown): DevinReviewRow | null {
  if (!isRecord(value)) return null;
  if (value['v'] !== 1) return null;
  const key = value['key'];
  if (!boundedText(key, 200)) return null;
  const repo = value['repo'];
  if (typeof repo !== 'string' || !REPO_LABEL.test(repo)) return null;
  const number = value['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
  const headSha = value['headSha'];
  if (typeof headSha !== 'string' || !HEAD_SHA.test(headSha)) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const day = value['day'];
  if (!boundedText(day, 40)) return null;
  const origin = value['origin'];
  if (typeof origin !== 'string' || !ORIGINS.has(origin)) return null;
  const outcome = value['outcome'];
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return null;
  const reason = value['reason'];
  if (!(reason === undefined || boundedText(reason, 120))) return null;
  const status = value['status'];
  if (!(status === undefined || (typeof status === 'string' && REVIEW_STATUSES.has(status)))) return null;
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    repo,
    repoKey: repo.toLowerCase(),
    number,
    key,
    origin: origin as DevinReviewRow['origin'],
    outcome: outcome as DevinReviewRow['outcome'],
    reason: typeof reason === 'string' ? reason : null,
    status: typeof status === 'string' ? status : null,
  };
}

/**
 * Pure: parse one journal file's text into validated rows plus the
 * count of lines that were not on-contract records — malformed JSON
 * and off-contract rows are counted, never guessed.
 */
export function parseDevinReviewJournal(text: string): { rows: DevinReviewRow[]; invalidRows: number } {
  const rows: DevinReviewRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseDevinReviewJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-cell in-window fold before the recurring bars apply. */
export interface DevinReviewCellFold {
  kind: DevinReviewCellKind;
  /** In-window adverse rows carrying the cell's evidence. */
  rows: number;
  /** Distinct UTC days. */
  days: Set<string>;
  /** Distinct pull request numbers. */
  prs: Set<number>;
  /** Example `repo#number` references — the reviews that keep recurring. */
  examples: string[];
  /** Origin tallies across the cell's rows (fleet autopilot vs cli). */
  origins: Map<string, number>;
  /** Recorded reason codes across the cell's rows, most frequent first is applied later. */
  reasons: Map<string, number>;
  /** Recorded review statuses across the cell's rows. */
  statuses: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface DevinReviewFold {
  /** In-window on-contract rows for the target repository — the share denominator. */
  rows: number;
  cells: Map<DevinReviewCellKind, DevinReviewCellFold>;
  /** Non-blank lines the writer's contract rejected. */
  invalidRows: number;
  /** Parsed rows outside the window. */
  outsideWindow: number;
  /** Parsed rows naming another repository. */
  otherRepo: number;
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

const cellKeyOf = (row: DevinReviewRow, resolved: ReadonlySet<string>, nowMs: number): DevinReviewCellKind | null => {
  if (row.outcome === 'failed') return 'failed';
  if (row.outcome === 'quota-exhausted') return 'quota-exhausted';
  // 'requested' resolves only through a terminal sibling on the same key;
  // absent one past the staleness bound the request is orphaned — the
  // writer died mid-flight and the key refuses 'duplicate' forever.
  if (row.outcome === 'requested' && !resolved.has(row.key) && nowMs - row.atMs > DEVIN_REVIEW_ORPHAN_STALE_MS) {
    return 'orphaned-request';
  }
  return null;
};

/**
 * Pure: fold journal text into per-kind cells for one repository.
 * Rows outside the window, rows naming another repository, healthy
 * 'requested'/'triggered' rows and malformed lines never join a cell.
 */
export function foldDevinReviewRows(
  text: string,
  opts: { nowMs: number; windowMs?: number; repo: string },
): DevinReviewFold {
  const parsed = parseDevinReviewJournal(text);
  const fold: DevinReviewFold = { rows: 0, cells: new Map(), invalidRows: parsed.invalidRows, outsideWindow: 0, otherRepo: 0 };
  const windowMs = opts.windowMs ?? DEVIN_REVIEW_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + DEVIN_REVIEW_FUTURE_SKEW_MS;
  const targetRepo = opts.repo.trim().toLowerCase();
  // Resolution is a property of the whole retained journal, not the
  // window: a 'requested' row's terminal sibling shares its `at`, so it
  // is always in-window when the request is — but pairing over every
  // parsed row keeps the check honest even at the window's edges.
  const resolved = new Set<string>();
  for (const row of parsed.rows) {
    if (TERMINAL_OUTCOMES.has(row.outcome)) resolved.add(row.key);
  }
  for (const row of parsed.rows) {
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    if (row.repoKey !== targetRepo) { fold.otherRepo += 1; continue; }
    fold.rows += 1;
    const kind = cellKeyOf(row, resolved, opts.nowMs);
    if (kind === null) continue;
    let cell = fold.cells.get(kind);
    if (cell === undefined) {
      cell = { kind, rows: 0, days: new Set(), prs: new Set(), examples: [], origins: new Map(), reasons: new Map(), statuses: new Map(), firstMs: null, lastMs: null };
      fold.cells.set(kind, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.prs.add(row.number);
    if (cell.examples.length < MAX_EXAMPLES * 2 && !cell.examples.includes(`${row.repo}#${row.number}`)) {
      cell.examples.push(`${row.repo}#${row.number}`);
    }
    bump(cell.origins, row.origin);
    if (row.reason !== null) bump(cell.reasons, row.reason);
    if (row.status !== null) bump(cell.statuses, row.status);
    touch(cell, row.atMs);
  }
  for (const cell of fold.cells.values()) cell.examples = cell.examples.slice(0, MAX_EXAMPLES);
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface DevinReviewTally {
  /** Sanitized recorded text. */
  text: string;
  count: number;
}

export interface DevinReviewCell {
  kind: DevinReviewCellKind;
  /** In-window adverse rows carrying the cell's evidence. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** Distinct pull request numbers. */
  prs: number;
  /** In-window on-contract rows for the repository overall. */
  records: number;
  /** Example `repo#number` references. */
  examples: string[];
  /** Origin tallies across the cell's rows, most frequent first. */
  origins: DevinReviewTally[];
  /** Reason-code tallies across the cell's rows, most frequent first. */
  reasons: DevinReviewTally[];
  /** Review-status tallies across the cell's rows, most frequent first. */
  statuses: DevinReviewTally[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

function tallyOf(map: Map<string, number>, max: number): DevinReviewTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/**
 * Pure: recurring cells — a kind group at the row/day/PR bars.
 * 'quota-exhausted' sorts first (the sharpest signal — provider-side
 * exhaustion), then 'failed', then 'orphaned-request'.
 */
export function devinReviewCells(fold: DevinReviewFold, lowerBound = false): DevinReviewCell[] {
  const cells: DevinReviewCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < DEVIN_REVIEW_MIN_ROWS || cell.days.size < DEVIN_REVIEW_MIN_DAYS || cell.prs.size < DEVIN_REVIEW_MIN_PRS) continue;
    cells.push({
      kind: cell.kind,
      rows: cell.rows,
      days: [...cell.days].sort(),
      prs: cell.prs.size,
      records: fold.rows,
      examples: cell.examples,
      origins: tallyOf(cell.origins, MAX_PROMPT_TALLIES),
      reasons: tallyOf(cell.reasons, MAX_PROMPT_TALLIES),
      statuses: tallyOf(cell.statuses, MAX_PROMPT_TALLIES),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  const rank = (c: DevinReviewCell): number =>
    c.kind === 'quota-exhausted' ? 0 : c.kind === 'failed' ? 1 : 2;
  return cells.sort((a, b) => rank(a) - rank(b) || b.rows - a.rows || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <ashlr home>/devin/pr-reviews.jsonl — devinHome() in src/core/devin/store.ts resolves <ashlr home>/devin (ashlrHome in src/core/cloud/store.ts honors $ASHLR_HOME or ~/.ashlr). triggerDevinPrReviewOnce in src/core/devin/pr-review.ts appends one {v:1, key, repo, number, headSha, at, day, origin, outcome, reason?, status?} row per attempt outcome: \'requested\' once the enabled/daily-cap/dedupe/plan gates pass, then exactly one terminal row — \'triggered\' on an accepted API call (status the review lifecycle label), \'failed\' on a non-quota API error (reason the DevinFailureCode) or \'quota-exhausted\' on a quota/billing refusal. Refusals journal nothing. Callers: `ashlr devin review` (origin \'cli\', src/cli/devin.ts) and the merge autopilot\'s advisory review gate (origin \'fleet\', fleetDevinReview in src/core/fleet/merge-autopilot.ts). Its only readers until this feed were the writer\'s own dedupe scan — journalRows inside triggerDevinPrReviewOnce and the fleetDevinReview duplicate check — point-in-time "have we already asked" reads that never fold a recurrence.';

const REPRO = 'Reproduce the fold by reading <ashlr home>/devin/pr-reviews.jsonl directly, keeping on-contract rows whose `at` lands inside the window and whose repo names the target case-insensitively, classing \'failed\' and \'quota-exhausted\' outcomes as adverse, and flagging \'requested\' rows older than an hour whose key has no terminal sibling as orphaned. The writer and its dedupe/daily-cap gates this repository owns are src/core/devin/pr-review.ts; the API client and its failure vocabulary are src/core/devin/client.ts; the weekly-capacity gate is src/core/devin/weekly-capacity.ts.';

const NO_CHANGE = 'If the window has rolled forward, the failures were a transient API or provider incident the later rows recovered from, the quota exhaustion reflects a billing state only Mason can change, the orphans trace to a one-off host restart already fixed, or the reviews themselves are passing on the default branch now — report no-change and name the evidence.';

const fieldText = (value: string, max = FIELD_MAX): string =>
  scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);

const tallyText = (tallies: readonly DevinReviewTally[]): string =>
  tallies.map((t) => `'${fieldText(t.text, 80)}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: DevinReviewCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: DevinReviewCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: DevinReviewCell): string =>
  cell.records > 0 ? ` (${Math.round((cell.rows / cell.records) * 100)}% of the ${cell.records} in-window review rows)` : '';

const KIND_CLAIM: Record<DevinReviewCellKind, string> = {
  'quota-exhausted': 'the Devin API keeps refusing review triggers on quota or billing grounds — provider-side exhaustion',
  'failed': 'the Devin API keeps erroring on review triggers — a non-quota request failure',
  'orphaned-request': 'review triggers keep dying mid-flight — \'requested\' rows with no recorded outcome that now refuse \'duplicate\' forever',
};

function devinReviewPrompt(cell: DevinReviewCell): string {
  const claim = KIND_CLAIM[cell.kind];
  const origins = cell.origins.length === 0 ? '' : ` Origins: ${tallyText(cell.origins)}.`;
  const reasons = cell.reasons.length === 0 ? '' : ` Recorded reasons: ${tallyText(cell.reasons)}.`;
  const statuses = cell.statuses.length === 0 ? '' : ` Recorded statuses: ${tallyText(cell.statuses)}.`;
  const examples = cell.examples.length === 0 ? '' : ` Example pull requests: ${cell.examples.join(', ')}.`;
  return [
    `Phantom's Devin PR-review journal keeps recording ${claim} — ${cell.rows} adverse row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) and ${cell.prs} distinct pull request(s), the self-improvement work this backlog exists for.`,
    '',
    `Each row is one triggerDevinPrReviewOnce attempt outcome for outcome '${cell.kind}': ${cell.kind === 'orphaned-request' ? 'a \'requested\' row older than an hour whose key never gained a \'triggered\', \'failed\' or \'quota-exhausted\' sibling — the process died or the append was lost between the request and its outcome, and the dedupe scan now refuses that PR head as \'duplicate\' forever' : `outcome '${cell.kind}' — the API call was attempted and refused or errored`}.${origins}${reasons}${statuses}${examples}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    cell.kind === 'quota-exhausted'
      ? `Find why Devin reviews keep hitting quota exhaustion: read the newest rows' reason codes and the recorded origins — the fleet autopilot's advisory gate fires on every red-required pull request while \`ashlr devin review\` is manual, so a fleet-heavy origin mix points at review volume against the plan's quota. Check the weekly-capacity gate (src/core/devin/weekly-capacity.ts, readPublishedDevinWeekly) that should refuse before the API call, the review.maxPerDay config bound, and whether quota-exhausted rows cluster on one day (the writer refuses further attempts after the first quota row of the day, so each row is a distinct exhaustion event). Provider billing and plan changes are owner-only — name them rather than working around them.`
      : cell.kind === 'failed'
        ? `Find why Devin review triggers keep failing: read the newest rows' reason codes — DevinFailureCode values from src/core/devin/client.ts ('network', 'server', 'rate-limited', 'unparsed', 'auth', 'invalid-request' and friends) name which side erred. Check whether the failures cluster on one reason (a client timeout or retry gap this repository owns in src/core/devin/client.ts), on the connectedClient/org resolution in src/core/devin/service.ts, or on Devin-side incidents the journal cannot fix. The trigger path, its gates and the client are this repository's own; the Devin service itself is not.`
        : `Find why review triggers keep orphaning: an orphaned 'requested' row means the process died or was killed between append('requested') and the outcome append — check what runs triggerDevinPrReviewOnce (the merge autopilot's advisory gate in src/core/fleet/merge-autopilot.ts, \`ashlr devin review\` in src/core/cli/devin.ts) and what could kill it mid-call: deploys, daemon restarts, OOM kills, host sleep. Each orphan also permanently dedupes its PR head — check whether the dedupe should treat a stale unresolved 'requested' row as retryable rather than 'duplicate' (src/core/devin/pr-review.ts journalRows + the duplicate check). The trigger path and the merge-autopilot call site are this repository's own.`,
    '',
    `Fix what lives here — the trigger path's failure handling, the dedupe's treatment of orphaned requests, the capacity gate's accuracy, or the client retry/timeout bounds.${cell.kind === 'quota-exhausted' ? ' If the exhaustion reflects a provider plan cap only Mason can change, name it as owner-only.' : ''} ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

const TITLES: Record<DevinReviewCellKind, string> = {
  'quota-exhausted': 'Devin PR reviews keep hitting quota exhaustion',
  'failed': 'Devin PR review triggers keep failing',
  'orphaned-request': 'Devin PR review triggers keep orphaning mid-flight',
};

const AREAS: Record<DevinReviewCellKind, string> = {
  'quota-exhausted': 'devin-review-quota',
  'failed': 'devin-review-failed',
  'orphaned-request': 'devin-review-orphaned',
};

function devinReviewItem(cell: DevinReviewCell, repo: string): CloudBacklogItem {
  const id = `devin-review-${cell.kind}-${createHash('sha256').update(`pr-reviews:${repo.trim().toLowerCase()}:${cell.kind}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: TITLES[cell.kind].slice(0, MAX_TITLE_CHARS),
    prompt: devinReviewPrompt(cell),
    area: AREAS[cell.kind],
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

function oversizePrompt(): string {
  return [
    `Phantom's Devin PR-review journal has outgrown its own read bound — every review trigger now refuses 'request-failed'/'unavailable' before it can journal or call the API, the self-improvement work this backlog exists for.`,
    '',
    `pr-reviews.jsonl is append-only with no rotation: triggerDevinPrReviewOnce's journalRows throws 'Review journal exceeds read limit.' once the file passes ${PR_REVIEW_JOURNAL_MAX_BYTES} bytes, the outer catch converts it to a refusal, and fleetDevinReview reports the advisory review as 'refused'. The file records this install's Devin review attempts across every repository and origin — the fleet autopilot's advisory gate and \`ashlr devin review\` alike — so the condition is install-wide, not one repo's evidence.`,
    '',
    EVIDENCE,
    '',
    `Find why the journal reached its bound and fix the growth or the bound: the writer appends two rows per attempt ('requested' plus one terminal outcome) with no compaction — check whether the dedupe scan really needs the full history (it keys on key/day/outcome, so a bounded retention or a compacted index may serve it), whether PR_REVIEW_JOURNAL_MAX_BYTES in src/core/devin/pr-review.ts should rise, or whether the file should rotate like the sibling journals do. The trigger path and journal contract are this repository's own.`,
    '',
    `If the file was already truncated or rotated by hand and the newest tail reads clean, report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function oversizeItem(repo: string): CloudBacklogItem {
  return {
    id: `devin-review-journal-oversize-${createHash('sha256').update(`pr-reviews-oversize:${repo.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`,
    title: 'Devin PR-review journal exceeded its read bound — every trigger refuses'.slice(0, MAX_TITLE_CHARS),
    prompt: oversizePrompt(),
    area: 'devin-review-oversize',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the Devin PR-review journal's recurring adverse
 * evidence plus its oversize condition. Total: any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function devinReviewBacklogItems(opts: DevinReviewItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? DEVIN_REVIEW_WINDOW_MS;
    const journalPath = opts.journalPath ?? join(devinHome(), 'pr-reviews.jsonl');
    // The tail bound IS the writer's own read bound: truncated means the
    // file passed PR_REVIEW_JOURNAL_MAX_BYTES and journalRows now refuses
    // every trigger — the oversize condition — while the retained tail
    // still folds cells as a stated lower bound.
    const read = await readLedgerTail(journalPath, PR_REVIEW_JOURNAL_MAX_BYTES);
    if (read.state !== 'read') return [];
    const fold = foldDevinReviewRows(read.text, { nowMs, windowMs, repo });
    const cells = devinReviewCells(fold, read.truncated);
    const items: CloudBacklogItem[] = [];
    // Oversize is an install-wide journal-health condition with no repo
    // attribution — emit it only for the fleet's own repository, the
    // sibling convention for repo-less install evidence.
    if (read.truncated && fleetRepoName(repo) === FLEET_REPO_NAME) {
      items.push(oversizeItem(repo));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? DEVIN_REVIEW_BACKLOG_MAX_ITEMS, DEVIN_REVIEW_ITEM_HARD_MAX));
    items.push(...cells.slice(0, limit).map((cell) => devinReviewItem(cell, repo)));
    return items.slice(0, DEVIN_REVIEW_ITEM_HARD_MAX);
  } catch {
    return [];
  }
}
