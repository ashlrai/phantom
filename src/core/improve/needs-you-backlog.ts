/**
 * Needs-you auto-resolve audit journal → self-improvement backlog items.
 *
 * `phm needs-you resolve --auto` (and POST /api/needs-you/resolve) runs
 * resolveAutoNeedsYou (src/core/needs-you/index.ts): every auto-class
 * item on the NEEDS-MASON.md ledger takes its forward action — an
 * approval's first option, else "go ahead" — through resolveNeedsMason
 * (src/core/fleet/needs-mason-resolve.ts), which posts one
 * needs_mason.resolved envelope on the durable bus and appends the
 * resolved marker line. Every attempt appends one audit record to
 * <runs>/needs-you-auto.jsonl under the fleet runs directory:
 *
 *   {item: {id, title}, action, at, reason, result?, error?}
 *
 * An attempt that fails to resolve appends the same record marked
 * result:'failed' with a bounded, secret-scrubbed error — the writer
 * journals the failure precisely because "a resolve that keeps failing
 * is durable evidence … where the report's failed list evaporates with
 * it". Until now the journal's only readers were `phm needs-you log`
 * and the last-50 audit slice inside GET /api/needs-you — point-in-time
 * surfaces someone had to run and read — so an auto item that kept
 * failing, or a failure mode that kept recurring across items, never
 * became work: the item simply stayed on the auto list being retried
 * (and failing) every pass, or the whole auto-resolve pass kept failing
 * while the needs-you surfaces still reported success.
 *
 * needsYouAutoBacklogItems carries the tail into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. needs-you-auto.jsonl is read once through
 *    readLedgerTail's bounded no-follow tail; nothing is written and
 *    no network is touched. A missing, unreadable or non-file journal
 *    yields no items.
 *  - Writer-contract rows only. A row counts only when it carries the
 *    audit shape isRecord enforces — item.id inside the writer's own
 *    nm-<12 hex> id shape, item.title/action/reason/at strings with
 *    `at` parsing under the shared ledger timestamp dialect, and
 *    result/error inside the recorded vocabulary. Only result:'failed'
 *    rows are adverse evidence; resolved attempts (result absent or
 *    'resolved', including every record written before failures were
 *    journaled) count as window context, never as failures. Malformed
 *    lines are skipped, never guessed.
 *  - Adverse means recorded failure, never inferred cause. The fold
 *    quotes the recorded error text — the resolve step's own bounded,
 *    scrubbed string ('The bus did not accept the resolution.', 'The
 *    resolution marker could not be written; retry.', 'No such
 *    needs-you item.', a reply-too-long refusal, 'The resolve step
 *    threw.') — and leaves root-causing to the session; a failed row
 *    that recorded no error groups under an explicit unrecorded label,
 *    never a guessed cause.
 *  - Recurring means recorded across days. An item cell emits only at
 *    NEEDS_YOU_AUTO_CHAIN_MIN_ROWS failed attempts spanning
 *    NEEDS_YOU_AUTO_CHAIN_MIN_DAYS distinct UTC days — one transient
 *    bus refusal never queues a session. An error-mode cell emits only
 *    when the same recorded error covers NEEDS_YOU_AUTO_ERROR_MIN_ITEMS
 *    distinct items across NEEDS_YOU_AUTO_ERROR_MIN_DAYS days — a
 *    shared failure mode, not one stuck item (that is the item cell's
 *    job). A wave cell emits only at NEEDS_YOU_AUTO_WAVE_MIN_ITEMS
 *    distinct failing items across NEEDS_YOU_AUTO_WAVE_MIN_DAYS days —
 *    isolated failures are routine churn, a broad failure pattern is
 *    not.
 *  - Fleet machinery only. The journal is this install's auto-resolve
 *    audit — it carries no repository column — so items emit only when
 *    the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence feeds apply.
 *  - Dedup is downstream. Item ids key on the cell identity — the
 *    needs-you item id, the recorded error text, or the wave — never
 *    the counts or timestamps, so a refresh re-derives the same ids
 *    and appendUserBacklogItems adds only what is new; shifted counts
 *    do not spawn twin items, and a journal that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, item titles, actions, reasons and errors
 *    are scrubbed, flattened and capped before they reach a prompt, a
 *    truncated tail is stated as a lower bound, and the brief carries
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cell count is bounded by item/error diversity. */
export const NEEDS_YOU_AUTO_MAX_ITEMS = 8;
const NEEDS_YOU_AUTO_ITEM_HARD_MAX = 25;
/** Evidence window: seven days — the recurring-flake/sibling convention for fleet-evidence feeds. */
export const NEEDS_YOU_AUTO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds apply. */
const NEEDS_YOU_AUTO_FUTURE_SKEW_MS = 60_000;
/** Failed attempts one item needs inside the window before it counts as recurring. */
export const NEEDS_YOU_AUTO_CHAIN_MIN_ROWS = 2;
/** Distinct UTC days those attempts must span — recurring means across days, not one burst. */
export const NEEDS_YOU_AUTO_CHAIN_MIN_DAYS = 2;
/** Distinct items the same recorded error must cover before it counts as a shared failure mode. */
export const NEEDS_YOU_AUTO_ERROR_MIN_ITEMS = 2;
/** Distinct UTC days the shared error's attempts must span. */
export const NEEDS_YOU_AUTO_ERROR_MIN_DAYS = 2;
/** Distinct items with failures the wave cell needs inside the window. */
export const NEEDS_YOU_AUTO_WAVE_MIN_ITEMS = 3;
/** Distinct UTC days the wave's failures must span. */
export const NEEDS_YOU_AUTO_WAVE_MIN_DAYS = 2;
/** Bounded tail for the audit journal; a row is a few hundred bytes so this covers thousands of attempts. */
const NEEDS_YOU_AUTO_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The needs-you item id shape itemId() mints: nm- + 12 hex of the ledger line's sha256. */
const NEEDS_YOU_ITEM_ID = /^nm-[0-9a-f]{12}$/;
/** Item titles are ledger text; flatten, scrub and cap before they reach a prompt. */
const MAX_TITLE_FIELD_CHARS = 80;
/** Action and reason strings are ledger-recorded text; flatten, scrub and cap. */
const MAX_FIELD_CHARS = 120;
/** The writer bounds error text at 200 chars; the same bound keys the error-mode tally. */
const MAX_ERROR_CHARS = 200;
/** Error tally label for a failed row that recorded no usable error string. */
const UNRECORDED_ERROR = '(error unrecorded)';
/** Distinct error tallies quoted inside one prompt. */
const MAX_PROMPT_ERRORS = 4;
/** The fleet's own repository label: auto-resolve evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';

export interface NeedsYouAutoItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding needs-you-auto.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default NEEDS_YOU_AUTO_WINDOW_MS). */
  windowMs?: number;
  /** Journal override (default: <runsDir>/needs-you-auto.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default NEEDS_YOU_AUTO_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** One validated failed auto-resolve attempt: the recorded evidence the fold needs. */
export interface NeedsYouAutoRecord {
  /** The needs-you item id, nm-<12 hex> form. */
  itemId: string;
  /** Recorded item title, or null when the row carried none usable. */
  title: string | null;
  /** The forward action the attempt took, or null when none was usable. */
  action: string | null;
  /** The recorded classifyNeedsYou reason, or null when none was usable. */
  reason: string | null;
  /** The recorded bounded error, or null when the failed row carried none usable. */
  error: string | null;
  /** Row timestamp in ms. */
  atMs: number;
  /** UTC day key ('YYYY-MM-DD') the timestamp falls in. */
  utcDay: string;
}

export interface NeedsYouAutoJournalFold {
  /** Validated failed-attempt rows whose timestamp landed inside the window. */
  records: NeedsYouAutoRecord[];
  /** Valid audit rows inside the window that resolved — context, never adverse. */
  resolved: number;
  /** Retained-tail lines that failed JSON parse or never formed a valid row. */
  invalidRows: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return text === '' ? null : text.slice(0, max);
}

const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The error-mode key: the recorded error text, or the explicit unrecorded label. */
function errorKeyOf(record: NeedsYouAutoRecord): string {
  return record.error ?? UNRECORDED_ERROR;
}

type ParsedAuditRow =
  | { failed: Omit<NeedsYouAutoRecord, 'utcDay'> }
  | { resolved: true; atMs: number };

/**
 * Validate one audit row under the writer's contract (the isRecord guard
 * in src/core/needs-you/index.ts plus the item id shape itemId mints).
 * Returns the failed record's fields for result:'failed', a resolved
 * marker carrying the row's timestamp for every other valid attempt, or
 * null when the row cannot be an audit record at all.
 */
function parseAuditRow(row: Record<string, unknown>): ParsedAuditRow | null {
  const item = row['item'];
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const entry = item as Record<string, unknown>;
  const id = entry['id'];
  const title = entry['title'];
  if (typeof id !== 'string' || !NEEDS_YOU_ITEM_ID.test(id)) return null;
  if (typeof title !== 'string') return null;
  const action = row['action'];
  const at = row['at'];
  const reason = row['reason'];
  if (typeof action !== 'string' || typeof at !== 'string' || typeof reason !== 'string') return null;
  const result = row['result'];
  if (result !== undefined && result !== 'resolved' && result !== 'failed') return null;
  const error = row['error'];
  if (error !== undefined && typeof error !== 'string') return null;
  const atMs = parseLedgerTs(at);
  if (atMs === null) return null;
  if (result !== 'failed') return { resolved: true, atMs };
  return {
    failed: {
      itemId: id,
      title: fieldText(title, MAX_TITLE_FIELD_CHARS),
      action: fieldText(action, MAX_FIELD_CHARS),
      reason: fieldText(reason, MAX_FIELD_CHARS),
      error: fieldText(error, MAX_ERROR_CHARS),
      atMs,
    },
  };
}

/**
 * Pure: fold one audit-journal tail into validated in-window evidence.
 * Rows are validated under the writer's contract; rows whose timestamp
 * cannot be placed inside [nowMs - windowMs, nowMs + skew] never reach
 * the fold. Only result:'failed' rows become records; every other valid
 * row counts toward `resolved` so the wave cell can quote the pass's
 * own success context. title/action/reason/error degrade to null rather
 * than suppressing the row — they are prompt context, not attribution.
 */
export function foldNeedsYouAutoJournal(text: string, nowMs: number, windowMs: number): NeedsYouAutoJournalFold {
  const fold: NeedsYouAutoJournalFold = { records: [], resolved: 0, invalidRows: 0 };
  const since = nowMs - windowMs;
  const until = nowMs + NEEDS_YOU_AUTO_FUTURE_SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) { fold.invalidRows += 1; continue; }
    const parsed = parseAuditRow(row as Record<string, unknown>);
    if (parsed === null) { fold.invalidRows += 1; continue; }
    const atMs = 'failed' in parsed ? parsed.failed.atMs : parsed.atMs;
    if (atMs < since || atMs > until) continue;
    if ('resolved' in parsed) { fold.resolved += 1; continue; }
    fold.records.push({ ...parsed.failed, utcDay: dayOfMs(atMs) });
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** One recurring item: the same needs-you item keeps failing auto-resolve. */
export interface NeedsYouItemChainCell {
  kind: 'item';
  /** The needs-you item id (nm-<12 hex>), quoted as an opaque id. */
  itemId: string;
  /** Recorded item title, or null. */
  title: string | null;
  /** The forward action the attempts took, or null. */
  action: string | null;
  /** Failed attempts the item recorded inside the window. */
  rows: number;
  /** Distinct UTC days the item's failures span, sorted. */
  days: string[];
  /** Per-error tallies of the item's failures, most frequent first. */
  errors: [string, number][];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

/** One recurring failure mode: the same recorded error across distinct items. */
export interface NeedsYouErrorCell {
  kind: 'error';
  /** The recorded error text (bounded, scrubbed) or the unrecorded label. */
  error: string;
  /** Distinct needs-you items the error covered inside the window. */
  items: number;
  /** Failed attempts carrying the error inside the window. */
  rows: number;
  /** Distinct UTC days the error's failures span, sorted. */
  days: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

/** The breadth cell: enough distinct items failing to read as a pass-level pattern. */
export interface NeedsYouWaveCell {
  kind: 'wave';
  /** Distinct needs-you items with failed attempts inside the window. */
  items: number;
  /** Total failed attempts inside the window. */
  rows: number;
  /** Valid resolved attempts inside the same window — pass context, never adverse. */
  resolved: number;
  /** Distinct UTC days the failures span, sorted. */
  days: string[];
  /** Per-error tallies across every in-window failure, most frequent first. */
  errors: [string, number][];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export type NeedsYouAutoCell = NeedsYouItemChainCell | NeedsYouErrorCell | NeedsYouWaveCell;

function tallyOf(map: Map<string, number>, max: number): [string, number][] {
  return [...map.entries()]
    .map(([text, count]) => [text, count] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max);
}

interface ItemAccum {
  itemId: string;
  title: string | null;
  action: string | null;
  rows: number;
  days: Set<string>;
  errors: Map<string, number>;
  firstMs: number;
  lastMs: number;
}

interface ErrorAccum {
  error: string;
  items: Set<string>;
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
}

function isoOrNull(ms: number): string | null {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Pure: the recurring cells the fold justifies. An item emits a chain
 * cell only while its failed attempts reach NEEDS_YOU_AUTO_CHAIN_MIN_ROWS
 * and span NEEDS_YOU_AUTO_CHAIN_MIN_DAYS distinct UTC days; an error
 * emits only while its recorded text covers
 * NEEDS_YOU_AUTO_ERROR_MIN_ITEMS distinct items across
 * NEEDS_YOU_AUTO_ERROR_MIN_DAYS days; the wave emits only while the
 * window's failures cover NEEDS_YOU_AUTO_WAVE_MIN_ITEMS distinct items
 * across NEEDS_YOU_AUTO_WAVE_MIN_DAYS days. Chains sort by rows
 * descending then item id, error cells by rows descending then text,
 * the wave sorts last. Deterministic.
 */
export function needsYouAutoCells(fold: NeedsYouAutoJournalFold, resolved = 0, lowerBound = false): NeedsYouAutoCell[] {
  const items = new Map<string, ItemAccum>();
  const errors = new Map<string, ErrorAccum>();
  const allDays = new Set<string>();
  const allErrors = new Map<string, number>();
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const record of fold.records) {
    let acc = items.get(record.itemId);
    if (acc === undefined) {
      acc = { itemId: record.itemId, title: record.title, action: record.action, rows: 0, days: new Set(), errors: new Map(), firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY };
      items.set(record.itemId, acc);
    }
    acc.rows += 1;
    acc.days.add(record.utcDay);
    const key = errorKeyOf(record);
    acc.errors.set(key, (acc.errors.get(key) ?? 0) + 1);
    acc.firstMs = Math.min(acc.firstMs, record.atMs);
    acc.lastMs = Math.max(acc.lastMs, record.atMs);

    let eacc = errors.get(key);
    if (eacc === undefined) {
      eacc = { error: key, items: new Set(), rows: 0, days: new Set(), firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY };
      errors.set(key, eacc);
    }
    eacc.items.add(record.itemId);
    eacc.rows += 1;
    eacc.days.add(record.utcDay);
    eacc.firstMs = Math.min(eacc.firstMs, record.atMs);
    eacc.lastMs = Math.max(eacc.lastMs, record.atMs);

    allDays.add(record.utcDay);
    allErrors.set(key, (allErrors.get(key) ?? 0) + 1);
    firstMs = Math.min(firstMs, record.atMs);
    lastMs = Math.max(lastMs, record.atMs);
  }
  const chains: NeedsYouItemChainCell[] = [];
  for (const acc of items.values()) {
    if (acc.rows < NEEDS_YOU_AUTO_CHAIN_MIN_ROWS || acc.days.size < NEEDS_YOU_AUTO_CHAIN_MIN_DAYS) continue;
    chains.push({
      kind: 'item',
      itemId: acc.itemId,
      title: acc.title,
      action: acc.action,
      rows: acc.rows,
      days: [...acc.days].sort(),
      errors: tallyOf(acc.errors, MAX_PROMPT_ERRORS),
      firstSeen: isoOrNull(acc.firstMs),
      lastSeen: isoOrNull(acc.lastMs),
      lowerBound,
    });
  }
  chains.sort((a, b) => b.rows - a.rows || a.itemId.localeCompare(b.itemId));
  const errorCells: NeedsYouErrorCell[] = [];
  for (const acc of errors.values()) {
    if (acc.items.size < NEEDS_YOU_AUTO_ERROR_MIN_ITEMS || acc.days.size < NEEDS_YOU_AUTO_ERROR_MIN_DAYS) continue;
    errorCells.push({
      kind: 'error',
      error: acc.error,
      items: acc.items.size,
      rows: acc.rows,
      days: [...acc.days].sort(),
      firstSeen: isoOrNull(acc.firstMs),
      lastSeen: isoOrNull(acc.lastMs),
      lowerBound,
    });
  }
  errorCells.sort((a, b) => b.rows - a.rows || a.error.localeCompare(b.error));
  const cells: NeedsYouAutoCell[] = [...chains, ...errorCells];
  if (items.size >= NEEDS_YOU_AUTO_WAVE_MIN_ITEMS && allDays.size >= NEEDS_YOU_AUTO_WAVE_MIN_DAYS) {
    cells.push({
      kind: 'wave',
      items: items.size,
      rows: fold.records.length,
      resolved,
      days: [...allDays].sort(),
      errors: tallyOf(allErrors, MAX_PROMPT_ERRORS),
      firstSeen: isoOrNull(firstMs),
      lastSeen: isoOrNull(lastMs),
      lowerBound,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const NO_CHANGE = 'If the window has rolled forward, the failures were transient infrastructure churn that has since recovered, the failing items were resolved or removed from the NEEDS-MASON.md ledger by other means, or the cause is owner-side (host permissions on ~/.ashlr-runs, the durable bus itself) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the writer, the reader gap and the reproduction fold are named so the session can verify it. */
const EVIDENCE = 'The evidence is needs-you-auto.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the append-only audit journal resolveAutoNeedsYou (src/core/needs-you/index.ts) writes for `phm needs-you resolve --auto` and POST /api/needs-you/resolve — one {item:{id,title}, action, at, reason, result?, error?} row per auto-resolve attempt, result:\'failed\' rows carrying the resolve step\'s bounded, scrubbed error. Until this feed the journal\'s only readers were `phm needs-you log` and the last-50 audit slice inside GET /api/needs-you — point-in-time surfaces someone had to run and read — so recurring auto-resolve failures never became work even though the writer journals them precisely to stay durable evidence. The failed rows\' error text is resolveNeedsMason\'s own recorded string: a bus refusal, an unwritable resolution marker, an item the ledger read cannot find, a reply-too-long refusal, or a thrown resolve step (src/core/fleet/needs-mason-resolve.ts).';

const tallyText = (tallies: readonly [string, number][]): string =>
  tallies.length === 0 ? 'none recorded' : tallies.map(([text, count]) => `'${text}' ×${count}`).join(', ');

const boundText = (lowerBound: boolean): string =>
  lowerBound ? ' The journal tail was truncated at the bounded read, so these counts cover only the retained rows — a lower bound, not the full window.' : '';

const seenText = (firstSeen: string | null, lastSeen: string | null): string => {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen ? ` Recorded ${firstSeen}.` : ` Recorded ${firstSeen} through ${lastSeen}.`;
};

function itemPrompt(cell: NeedsYouItemChainCell): string {
  const titleText = cell.title === null ? 'untitled' : `'${cell.title}'`;
  const actionText = cell.action === null ? 'an unrecorded action' : `'${cell.action}'`;
  return [
    `Phantom's needs-you auto-resolve audit journal keeps recording the same item failing to resolve — ${titleText} (${cell.itemId}) failed ${cell.rows} auto-resolve attempt(s) across ${cell.days.length} distinct UTC day(s) inside the 7-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each failed row is one recorded attempt by resolveAutoNeedsYou to take the item's forward action — ${actionText} — through resolveNeedsMason, journaled as result:'failed' with the resolve step's own bounded error precisely so the failure stays durable evidence. An auto item is supposed to clear itself every pass; one that keeps failing either has a deterministic defect the pass can never satisfy or keeps racing the ledger — and it stays on the auto list being retried (and failing) every run while \`phm needs-you\` still shows it as fleet-handleable.`,
    '',
    `Recorded errors: ${tallyText(cell.errors)}.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the auto-resolve pass and its audit journal (src/core/needs-you/index.ts resolveAutoNeedsYou), the resolve path it calls (src/core/fleet/needs-mason-resolve.ts resolveNeedsMason — the reply it builds is 'auto: <action> (<reason>)', so a long approval first-option can deterministically trip reply-too-long), the NEEDS-MASON.md ledger scan both share, and the needs-you surfaces that report the item as auto (\`phm needs-you\`, \`phm needs-you log\`, GET /api/needs-you). Find out which recorded error kept firing for this item and why — reproduce with \`phm needs-you resolve --auto --dry-run\` against a scratch runs dir holding the same ledger shape, then fix the resolve path, the reply construction or the classifier in this repository's src/. The NEEDS-MASON.md ledger and the bus inbox under ~/.ashlr-runs are host state — repairing them is owner-only. If the failures were transient churn that has since recovered, the item was resolved or removed by other means, or the cause is owner-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function errorPrompt(cell: NeedsYouErrorCell): string {
  return [
    `Phantom's needs-you auto-resolve audit journal keeps recording the same failure across different items — '${cell.error}' covers ${cell.items} distinct needs-you item(s) over ${cell.rows} failed attempt(s) across ${cell.days.length} distinct UTC day(s) inside the 7-day window, the self-improvement work this backlog exists for.`,
    '',
    `One recorded error recurring across distinct items is a shared cause, not item noise: the same resolveNeedsMason refusal firing for unrelated auto items points at the pass's dependencies — the durable bus refusing envelopes, the NEEDS-MASON.md ledger unreadable or unwritable so every resolve reads 'No such needs-you item.', or a thrown resolve step — rather than any one item's content.`,
    '',
    `Days: ${cell.days.join(', ')}.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the same surfaces the per-item prompts name — the auto-resolve pass and audit journal (src/core/needs-you/index.ts), the resolve path and its error vocabulary (src/core/fleet/needs-mason-resolve.ts), the bus inbox writer it depends on (src/core/fleet/bus-inbox.ts appendBusInbox), and the ledger read/write it performs on NEEDS-MASON.md. Match the recorded error text to its fail() site, reproduce with \`phm needs-you resolve --auto --dry-run\` against a scratch runs dir, and fix the dependency or the error mapping in this repository's src/. If the error was a transient outage that has since recovered, the items were resolved by other means, or the cause is owner-side host state — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function wavePrompt(cell: NeedsYouWaveCell): string {
  return [
    `Phantom's needs-you auto-resolve audit journal keeps recording failures across the fleet's needs-you items — ${cell.items} distinct item(s) failed ${cell.rows} auto-resolve attempt(s) across ${cell.days.length} distinct UTC day(s) inside the 7-day window (${cell.resolved} resolved attempt(s) recorded in the same window), the self-improvement work this backlog exists for.`,
    '',
    `Isolated failures are routine churn; this many distinct items failing to self-resolve inside one window reads as a pass-level signal — the auto-resolve pass itself erroring on every item, its bus or ledger dependencies degraded, or a classifier/reply defect producing deterministic per-item failures at volume. The auto list is the fleet's promise that ordinary work never reaches Mason; failures at this breadth mean that promise is quietly not being kept.`,
    '',
    `Recorded errors: ${tallyText(cell.errors)}. Days: ${cell.days.join(', ')}.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the same surfaces the per-item and per-error prompts name — the auto-resolve pass (src/core/needs-you/index.ts), the resolve path and error vocabulary (src/core/fleet/needs-mason-resolve.ts), the bus inbox dependency (src/core/fleet/bus-inbox.ts) and the NEEDS-MASON.md ledger contract. Read the per-item and per-error backlog items this feed may also have queued for the specific stuck items and failure modes, reproduce the pass against a scratch runs dir, and fix the shared cause in this repository's src/ — or, if the breadth traces to one deterministic defect (e.g., reply construction), fix that once rather than each item. If the failures were a one-off outage burst or all since recovered — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function needsYouAutoItem(cell: NeedsYouAutoCell, repo: string): CloudBacklogItem {
  const id = cell.kind === 'item'
    ? `needs-you-auto-item-${createHash('sha256').update(`needs-you-auto:item:${cell.itemId}`).digest('hex').slice(0, 16)}`
    : cell.kind === 'error'
      ? `needs-you-auto-error-${createHash('sha256').update(`needs-you-auto:error:${cell.error}`).digest('hex').slice(0, 16)}`
      : `needs-you-auto-wave-${createHash('sha256').update('needs-you-auto:wave').digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'item'
    ? `Needs-you item ${cell.title ?? cell.itemId} keeps failing auto-resolve`
    : cell.kind === 'error'
      ? `Needs-you auto-resolve keeps failing: ${cell.error}`
      : 'Needs-you auto-resolve keeps failing across items';
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'item' ? itemPrompt(cell) : cell.kind === 'error' ? errorPrompt(cell) : wavePrompt(cell),
    area: 'needs-you-auto',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the needs-you auto-resolve journal's recurring
 * failure cells. Total: a missing journal, another repository or any
 * read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function needsYouAutoBacklogItems(opts: NeedsYouAutoItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : NEEDS_YOU_AUTO_WINDOW_MS;
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env
    // value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const path = opts.journalPath ?? join(runsDir, 'needs-you-auto.jsonl');
    const tail = await readLedgerTail(path, NEEDS_YOU_AUTO_TAIL_BYTES);
    // A missing journal is a clean empty source; an unreadable or
    // non-file read means evidence exists that cannot be trusted —
    // fail closed. A truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];
    const fold = foldNeedsYouAutoJournal(tail.text, nowMs, windowMs);
    if (fold.records.length === 0) return [];
    const cells = needsYouAutoCells(fold, fold.resolved, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? NEEDS_YOU_AUTO_MAX_ITEMS, NEEDS_YOU_AUTO_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => needsYouAutoItem(cell, repo));
  } catch {
    return [];
  }
}
