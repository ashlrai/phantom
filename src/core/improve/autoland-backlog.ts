/**
 * Devin autoland decision journal recurring adverse outcomes →
 * self-improvement backlog items.
 *
 * `phm devin autoland` lands finished Devin sessions owned by the
 * connected key: it scans the org's sessions, requires a Devin-source
 * `.bundle` plus `.pr.md` attachment, publishes through the fork-only
 * land path, then terminates and archives. The resident daemon runs a
 * pass every ten minutes once connected (ensureDevinAutolandTimer in
 * src/core/devin/autoland-timer.ts, scheduled from
 * src/core/daemon/loop.ts), and every apply pass appends one
 * DevinAutolandDecision row per outcome to
 * `devin/autoland.jsonl` under the Ashlr home — passId, mode,
 * sessionId, decision, reason, job/pr/supersededPr/repo, error and
 * aggregate skip counts. Dry runs journal nothing.
 *
 * Until now the journal's only reader was the pass itself: the same
 * file feeds its own idempotency checks (already-landed, backoff,
 * gave-up, supersede retries) and `phm devin autoland --json` prints
 * only the current pass's decisions — a report of one tick, not a
 * trend. A landing path that kept failing bundles, a superseded-PR
 * close that kept erroring, sessions that finished without the
 * required attachments, or a pass that kept throwing never became
 * work even though the pipeline lands this fleet's Devin-produced PRs.
 *
 * autolandBacklogItems carries the same journal into discoverBacklog:
 * per failure class, the distinct sessions (or passes, for the
 * pass-scoped kinds) the journal recorded inside the window become one
 * item each once they reach the recurring bars.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through the bounded,
 *    no-follow tail read every sibling feed shares; nothing is written
 *    and no network is touched. A missing journal is a clean empty
 *    source; an unreadable or non-file read yields no items rather
 *    than folding partial evidence — unknown stays unknown — while a
 *    truncated tail still folds the retained rows with the prompts
 *    stating the counts as lower bounds.
 *  - Rows count only under the writer's own contract: the
 *    DevinAutolandDecision shape runDevinAutoland appends (v:1,
 *    kind 'devin-autoland', parseable `at`, passId, mode, decision,
 *    reason). Malformed lines, foreign schemas, untimestamped or
 *    future-stamped rows and decisions outside the recorded
 *    vocabulary are skipped, never guessed.
 *  - Only apply-mode evidence can exist — the writer journals apply
 *    passes only — but a row claiming dry-run is still validated
 *    against the contract rather than trusted blindly.
 *  - Recurring means recorded across units and days: a cell emits
 *    only when its distinct units reach AUTOLAND_MIN_UNITS AND span
 *    AUTOLAND_MIN_DAYS distinct UTC days inside the window — one
 *    unlucky session never queues a session's worth of work, and a
 *    single bad hour never does either.
 *  - Deliberate states never emit: killed and paused rows record
 *    operator/global switches working as designed, scanned rows carry
 *    aggregate skip counts, and already-landed, backoff,
 *    supersede-backoff, cap-reached, landed, archived, superseded and
 *    the would-* dry-run decisions are the pipeline working or its
 *    intended pacing — none are adverse evidence.
 *  - gave-up and supersede-gave-up are the terminal rows of the
 *    landing and close paths (five recorded failures on one bundle or
 *    PR pair): they fold into their path's cell with their own tally
 *    rather than minting a second item for the same root cause.
 *  - Fleet machinery only: the journal carries no repository column —
 *    every pass scans this install's connected Devin org — so items
 *    emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling feeds apply.
 *    Dedup is downstream: the item id hashes the cell kind, never the
 *    counts or timestamps, so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a class that stops
 *    accruing adverse rows simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import { devinHome } from '../devin/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the failure classes are few but unbounded in principle. */
export const AUTOLAND_BACKLOG_MAX_ITEMS = 8;
const AUTOLAND_ITEM_HARD_MAX = 25;
/**
 * Evidence window: the pass runs every ten minutes while connected, so
 * a week of journal covers thousands of passes — the sibling feeds'
 * 7-day convention gives recurring patterns room without letting
 * stale evidence linger.
 */
export const AUTOLAND_WINDOW_HOURS = 168;
/** Bounded tail for the journal; a row is ~300-800 bytes so this covers thousands of decisions. */
const AUTOLAND_TAIL_BYTES = 512 * 1024;
/** Journal file name under devinHome(), the writer's own constant value (autoland.ts record()). */
const AUTOLAND_JOURNAL_FILE = 'autoland.jsonl';
/** Distinct units one cell needs inside the window before it counts as recurring. */
export const AUTOLAND_MIN_UNITS = 3;
/** Distinct UTC days the units must span — recurring means recorded across days. */
export const AUTOLAND_MIN_DAYS = 2;
/** Future-skew allowance on row timestamps, same convention the sibling feeds tolerate. */
const AUTOLAND_FUTURE_SKEW_MS = 60_000;
/** The fleet's own repository label: autoland evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded identifiers are unbounded text; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Error strings the writer already scrubbed and capped at 300 chars; quoted shorter still. */
const MAX_ERROR_CHARS = 160;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Example identifiers quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;

/**
 * The semantic failure classes the fold emits. The recorded decision
 * vocabulary maps onto them: the terminal gave-up rows join their
 * path's cell so one root cause never mints two items.
 */
export type AutolandCellKind =
  | 'landing'
  | 'supersede-close'
  | 'archive'
  | 'attachments'
  | 'session'
  | 'pass'
  | 'identity';

/** Recorded decision → cell kind. Everything else the writer emits is success, pacing or deliberate state. */
const DECISION_KIND: Record<string, AutolandCellKind> = {
  'land-failed': 'landing',
  'gave-up': 'landing',
  'pending-supersede': 'supersede-close',
  'supersede-gave-up': 'supersede-close',
  'archive-failed': 'archive',
  'missing-attachments': 'attachments',
  'session-failed': 'session',
  'pass-failed': 'pass',
  'no-identity': 'identity',
};

/** Terminal rows of their path: five recorded failures, then the unit is abandoned for a new bundle or left for review. */
const TERMINAL_DECISIONS = new Set(['gave-up', 'supersede-gave-up']);

export interface AutolandItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal path override (default: join(devinHome(), 'autoland.jsonl')). */
  journalPath?: string;
  /** Evidence window in hours (default AUTOLAND_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default AUTOLAND_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window, ms epoch (default: now). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** First-seen-order, deduped-on-display-text, capped quote list. */
const pushQuoted = (list: string[], value: string | null): void => {
  if (value === null || value === '' || list.length >= MAX_EXAMPLES || list.includes(value)) return;
  list.push(value);
};

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const optStr = (row: Record<string, unknown>, key: string): string | null => {
  const v = row[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

/** One adverse journal row the fold keeps: a contract-valid DevinAutolandDecision in the evidence window. */
export interface ParsedAutolandRow {
  kind: AutolandCellKind;
  decision: string;
  terminal: boolean;
  atMs: number;
  /** Recurrence unit: the session for per-session decisions, else the pass. */
  unit: string;
  sessionId: string | null;
  passId: string;
  pr: string | null;
  supersededPr: string | null;
  repo: string | null;
  error: string | null;
}

/**
 * One journal row under the writer's contract: a ParsedAutolandRow for
 * an adverse decision, 'skip' for a contract-valid row whose decision
 * is success, pacing or deliberate state, or null for a contract
 * violation. The required fields are what record() always emits;
 * optional detail fields the fold quotes are accepted as strings or
 * absent — anything else makes the row off-contract and it is
 * skipped, never guessed.
 */
function parseAutolandRow(row: unknown): ParsedAutolandRow | 'skip' | null {
  if (!isRecord(row)) return null;
  if (row['v'] !== 1 || row['kind'] !== 'devin-autoland') return null;
  const atMs = parseLedgerTs(row['at']);
  if (atMs === null) return null;
  const passId = optStr(row, 'passId');
  if (passId === null) return null;
  const mode = row['mode'];
  if (mode !== 'apply' && mode !== 'dry-run') return null;
  const decision = optStr(row, 'decision');
  const reason = row['reason'];
  if (decision === null || typeof reason !== 'string') return null;
  const kind = DECISION_KIND[decision];
  if (kind === undefined) return 'skip';
  const sessionId = optStr(row, 'sessionId');
  // Every per-session decision carries sessionId; pass-scoped kinds
  // (pass-failed, no-identity) never do. A session-scoped row without
  // one still counts — under its pass, the only unit it provably has.
  const unit = sessionId ?? passId;
  return {
    kind,
    decision,
    terminal: TERMINAL_DECISIONS.has(decision),
    atMs,
    unit,
    sessionId,
    passId,
    pr: optStr(row, 'pr'),
    supersededPr: optStr(row, 'supersededPr'),
    repo: optStr(row, 'repo'),
    error: optStr(row, 'error'),
  };
}

/**
 * Pure: fold a journal tail into per-kind adverse evidence. Rows
 * outside the window, malformed JSON and off-contract shapes are
 * skipped — never guessed; `invalid` counts only lines that fail the
 * writer's contract, while contract-valid success, pacing and
 * deliberate-state rows simply contribute no adverse evidence.
 */
export function foldAutolandRows(
  text: string,
  cutoffMs: number,
  nowMs: number,
): { rows: ParsedAutolandRow[]; invalid: number } {
  const out: ParsedAutolandRow[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { invalid += 1; continue; }
    const parsed = parseAutolandRow(row);
    if (parsed === null) { invalid += 1; continue; }
    if (parsed === 'skip') continue;
    if (parsed.atMs < cutoffMs || parsed.atMs > nowMs + AUTOLAND_FUTURE_SKEW_MS) continue;
    out.push(parsed);
  }
  return { rows: out, invalid };
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** Per-kind in-window fold before the recurring bars apply. */
export interface AutolandKindFold {
  kind: AutolandCellKind;
  /** Adverse rows recorded for the kind. */
  rows: number;
  /** Distinct recurrence units (sessions, or passes for pass-scoped kinds). */
  units: Set<string>;
  /** Terminal rows within the kind (gave-up / supersede-gave-up). */
  terminal: number;
  /** Distinct UTC days the rows landed on. */
  days: Set<string>;
  /** Recorded repo labels (supersede-close rows carry one), most frequent first. */
  repos: Map<string, number>;
  /** Up to MAX_EXAMPLES scrubbed error strings, first-seen order. */
  errors: string[];
  /** Up to MAX_EXAMPLES session ids, first-seen order. */
  sessions: string[];
  /** Up to MAX_EXAMPLES recorded PR references (pr or supersededPr), first-seen order. */
  prs: string[];
  /** ISO bounds of the rows; null when the kind recorded none. */
  firstMs: number | null;
  lastMs: number | null;
}

const emptyKindFold = (kind: AutolandCellKind): AutolandKindFold => ({
  kind, rows: 0, units: new Set(), terminal: 0, days: new Set(),
  repos: new Map(), errors: [], sessions: [], prs: [], firstMs: null, lastMs: null,
});

/**
 * Pure: fold validated rows into per-kind cells. Only rows inside the
 * window contribute; a kind emits only at the recurring bars of
 * distinct units across distinct UTC days.
 */
export function foldAutolandCells(rows: readonly ParsedAutolandRow[]): AutolandKindFold[] {
  const folds = new Map<AutolandCellKind, AutolandKindFold>();
  for (const row of rows) {
    let cell = folds.get(row.kind);
    if (cell === undefined) {
      cell = emptyKindFold(row.kind);
      folds.set(row.kind, cell);
    }
    cell.rows += 1;
    cell.units.add(row.unit);
    if (row.terminal) cell.terminal += 1;
    cell.days.add(dayOf(row.atMs));
    if (row.repo !== null) {
      const repo = fieldText(row.repo, MAX_FIELD_CHARS);
      if (repo !== '') cell.repos.set(repo, (cell.repos.get(repo) ?? 0) + 1);
    }
    pushQuoted(cell.errors, row.error === null ? null : fieldText(row.error, MAX_ERROR_CHARS));
    pushQuoted(cell.sessions, row.sessionId === null ? null : fieldText(row.sessionId));
    // On supersede rows both exist: supersededPr is the PR the close
    // targets, pr the replacement — quote the target first.
    pushQuoted(cell.prs, row.supersededPr === null ? null : fieldText(row.supersededPr));
    pushQuoted(cell.prs, row.pr === null ? null : fieldText(row.pr));
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  return [...folds.values()];
}

/** One emitted cell: the kind plus the recorded detail the prompt quotes. */
export interface AutolandCell {
  kind: AutolandCellKind;
  /** Adverse rows recorded for the kind inside the window. */
  rows: number;
  /** Distinct recurrence units behind those rows. */
  units: number;
  /** Terminal rows within the kind. */
  terminal: number;
  /** Sorted distinct UTC days the rows landed on. */
  days: string[];
  /** Top recorded repo labels, most frequent first (capped). */
  repos: { text: string; count: number }[];
  /** Up to MAX_EXAMPLES scrubbed error strings, first-seen order. */
  errors: string[];
  /** Up to MAX_EXAMPLES session ids, first-seen order. */
  sessions: string[];
  /** Up to MAX_EXAMPLES recorded PR references, first-seen order. */
  prs: string[];
  /** ISO bounds of the rows. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/**
 * Pure: the recurring cells the fold justifies — kinds whose distinct
 * units reach AUTOLAND_MIN_UNITS across AUTOLAND_MIN_DAYS distinct UTC
 * days. Sorted by row count, worst first.
 */
export function autolandCells(folds: readonly AutolandKindFold[], lowerBound = false): AutolandCell[] {
  const cells: AutolandCell[] = [];
  for (const cell of folds) {
    if (cell.units.size < AUTOLAND_MIN_UNITS || cell.days.size < AUTOLAND_MIN_DAYS) continue;
    cells.push({
      kind: cell.kind,
      rows: cell.rows,
      units: cell.units.size,
      terminal: cell.terminal,
      days: [...cell.days].sort(),
      repos: [...cell.repos.entries()]
        .map(([text, count]) => ({ text, count }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .slice(0, MAX_EXAMPLES),
      errors: [...cell.errors],
      sessions: [...cell.sessions],
      prs: [...cell.prs],
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) => b.rows - a.rows || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is devin/autoland.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME): runDevinAutoland (src/core/devin/autoland.ts) appends one DevinAutolandDecision per outcome on every apply pass — the resident daemon\'s autoland timer (src/core/devin/autoland-timer.ts, scheduled from src/core/daemon/loop.ts) runs one every ten minutes while Devin is connected and the publisher exists, and `phm devin autoland --apply` runs one on demand; dry runs journal nothing. Rows carry passId, mode, sessionId, decision, reason, job/pr/supersededPr/repo, scrubbed error and aggregate skip counts. The same file\'s only other reads are the pass\'s own idempotency checks (already-landed, backoff, gave-up, supersede retries) and `phm devin autoland --json` prints just the current pass — until this feed no reader folded the window.';

const NO_CHANGE = 'If the window has rolled forward, the failures were a transient Devin API or gh outage the next passes recovered from, the lane is deliberately paused or the connected key intentionally lacks the needed scope, or the cause is owner-side state only Mason can change (the Keychain-held credential, Devin-side session configuration, billing) — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: AutolandCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: AutolandCell): string =>
  cell.lowerBound ? ' The journal tail was truncated at the read, so these counts cover only the retained rows — a lower bound, not the full window.' : '';

const repoText = (cell: AutolandCell): string =>
  cell.repos.length === 0 ? '' : ` Recorded repositories: ${cell.repos.map((r) => `'${r.text}' ×${r.count}`).join(', ')}.`;

const sessionText = (cell: AutolandCell): string =>
  cell.sessions.length === 0 ? '' : ` Example session ids: ${cell.sessions.join(', ')}.`;

const prText = (cell: AutolandCell): string =>
  cell.prs.length === 0 ? '' : ` Recorded PR references: ${cell.prs.join(', ')}.`;

const errorText = (cell: AutolandCell): string =>
  cell.errors.length === 0 ? '' : ` Recorded errors: ${cell.errors.map((e) => `'${e}'`).join(' | ')}.`;

const terminalText = (cell: AutolandCell): string =>
  cell.terminal > 0 ? ` ${cell.terminal} of them are the terminal gave-up rows — units abandoned after five recorded failures.` : '';

function landingPrompt(cell: AutolandCell, windowDays: number): string {
  return [
    `Phantom's Devin autoland journal keeps recording landing failures — ${cell.rows} adverse decision(s) across ${cell.units} distinct session(s) inside the ${windowDays}-day window, spanning ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'land-failed' row is a bundle the pass could not land through the fork-only publish path; 'gave-up' rows mark bundles abandoned after five failures.${sessionText(cell)}${prText(cell)}${errorText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which side is failing: reproduce the tallies against devin/autoland.jsonl and the per-session landings ledger (devin/landings.jsonl, DEVIN_LAND_LEDGER_FILE), then check whether landDevinSession's merge-base computation, bundle download, fork-only publish or auto-merge policy in src/core/devin/land.ts is erroring, whether the recorded error strings name a gh/git/Devin API failure, or whether the sessions genuinely produce unlandable bundles — a producer-side prompt or attachment-contract gap this repo's Devin launch path owns.`,
    '',
    `Fix what lives here — the Devin land path, the autoland pass's failure handling and backoff, or the session launch prompts that mint the bundles. If the cause is a transient outage, deliberate pause, key scope or owner-side state, ${NO_CHANGE}`,
  ].join('\n');
}

function supersedeClosePrompt(cell: AutolandCell, windowDays: number): string {
  return [
    `Phantom's Devin autoland journal keeps recording superseded-PR close failures — ${cell.rows} adverse decision(s) across ${cell.units} distinct session(s) inside the ${windowDays}-day window, spanning ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'pending-supersede' row is a \`gh pr close\` on the old PR that errored and will retry after backoff; 'supersede-gave-up' rows mark pairs abandoned after five close failures, leaving sessions unarchived for review.${repoText(cell)}${prText(cell)}${errorText(cell)}${seenText(cell)}${terminalText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why the close keeps failing: the pass runs \`gh pr close <oldPr> --repo ashlrai/<repo>\` before archiving — check the recorded repo and PR references, whether the PRs are already closed or the recorded repo name is wrong, whether the gh comment body or auth is the failure, and whether the backoff is hiding a permanent refusal (a deleted head branch, a protected branch, a PR the connected account cannot close).`,
    '',
    `Fix what lives here — the supersede-close path in src/core/devin/autoland.ts, its repo/pr recording, or the retry/backoff contract. If the cause is deliberate state or owner-side gh auth, ${NO_CHANGE}`,
  ].join('\n');
}

function archivePrompt(cell: AutolandCell, windowDays: number): string {
  return [
    `Phantom's Devin autoland journal keeps recording archive failures — ${cell.rows} adverse decision(s) across ${cell.units} distinct session(s) inside the ${windowDays}-day window, spanning ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'archive-failed' row is a landed session whose terminate-then-archive cleanup errored; the next pass retries, so landed sessions pile up unarchived.${sessionText(cell)}${errorText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why cleanup keeps failing: the pass terminates a non-exit session then archives via the Devin client — check archiveSession/terminateSession in src/core/devin/client.ts and the connectedClient/service.js session state, whether the recorded errors name permission, not-found or rate-limit failures, and whether one bad session should stop blocking the rest of the pass.`,
    '',
    `Fix what lives here — the Devin client archive/terminate calls, the pass's cleanup ordering, or its error recording. If the cause is Devin-side state or owner-side auth, ${NO_CHANGE}`,
  ].join('\n');
}

function attachmentsPrompt(cell: AutolandCell, windowDays: number): string {
  return [
    `Phantom's Devin autoland journal keeps recording sessions that finish without the required attachments — ${cell.rows} adverse decision(s) across ${cell.units} distinct session(s) inside the ${windowDays}-day window, spanning ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'missing-attachments' row is a finished session with no Devin-source .bundle or no .pr.md — the pass cannot land it and never will until a new bundle appears.${sessionText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why sessions keep finishing unlandable: the pass needs the last Devin-source .bundle plus a .pr.md attachment — check listSessionAttachments parsing in src/core/devin/client.ts, the session prompts and playbooks that produce Devin sessions (the launch path and playbook refs in src/core/devin/), and whether the attachment contract drifted on either side.`,
    '',
    `Fix what lives here — the attachment detection, the launch prompts that must produce the artifacts, or the playbook contract. If the sessions genuinely produced nothing landable and the count is falling, ${NO_CHANGE}`,
  ].join('\n');
}

function sessionPrompt(cell: AutolandCell, windowDays: number): string {
  return [
    `Phantom's Devin autoland journal keeps recording per-session processing failures — ${cell.rows} adverse decision(s) across ${cell.units} distinct session(s) inside the ${windowDays}-day window, spanning ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'session-failed' row is a session the pass's per-session block threw on — the pass continues, but that session is skipped every pass.${sessionText(cell)}${errorText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why session processing keeps throwing: the per-session try block covers attachment listing, state reads, landing and cleanup — check listSessionAttachments/getSelf parsing in src/core/devin/client.ts and the fields the pass dereferences in src/core/devin/autoland.ts, and whether one malformed session or API shape change poisons every pass.`,
    '',
    `Fix what lives here — the Devin client parsing, the pass's per-session handling, or its error recording. If the cause is Devin-side state, ${NO_CHANGE}`,
  ].join('\n');
}

function passPrompt(cell: AutolandCell, windowDays: number): string {
  return [
    `Phantom's Devin autoland journal keeps recording whole-pass failures — ${cell.rows} adverse decision(s) across ${cell.units} distinct pass(es) inside the ${windowDays}-day window, spanning ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'pass-failed' row is the pass's outer catch firing — connectivity, identity read or session paging threw before per-session work could run, so nothing landed that pass.${errorText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why whole passes keep failing: the outer catch covers connectedClient/service.js, getSelf and listSessions paging — check \`phm devin status\`/\`phm devin fleet\`, the daemon's autoland timer readiness gate (publisher presence, connected client), and whether the recorded errors name auth, network or API-shape failures.`,
    '',
    `Fix what lives here — the Devin service client, the pass's outer handling, or the timer's readiness gate. If the cause is Devin being down or owner-side auth, ${NO_CHANGE}`,
  ].join('\n');
}

function identityPrompt(cell: AutolandCell, windowDays: number): string {
  return [
    `Phantom's Devin autoland journal keeps recording passes that cannot identify their principal — ${cell.rows} adverse decision(s) across ${cell.units} distinct pass(es) inside the ${windowDays}-day window, spanning ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'no-identity' row is a connected pass whose getSelf returned no usable principal — the pass returns before scanning, so autoland is fully stalled while it persists.${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why the connected key has no usable principal: the pass needs identity.principal 'service_user' with serviceUserId, or a PAT user identity — check \`phm devin status\`, the Keychain-held credential's scope and devin/connection.json (org id + principal, never the key), and whether getSelf's response shape in src/core/devin/client.ts drifted from what the pass reads.`,
    '',
    `Fix what lives here — the getSelf parsing or identity check in src/core/devin/, or the connection record's contract. If the key genuinely lacks a principal and only Mason can re-issue it, ${NO_CHANGE}`,
  ].join('\n');
}

const TITLES: Record<AutolandCellKind, string> = {
  'landing': 'Devin autoland keeps failing to land session bundles',
  'supersede-close': 'Devin autoland keeps failing to close superseded PRs',
  'archive': 'Devin autoland keeps failing to archive landed sessions',
  'attachments': 'Devin sessions keep finishing without autoland-required attachments',
  'session': 'Devin autoland keeps failing to process sessions',
  'pass': 'Devin autoland passes keep failing',
  'identity': 'Devin autoland cannot identify its principal',
};

const PROMPTS: Record<AutolandCellKind, (cell: AutolandCell, windowDays: number) => string> = {
  'landing': landingPrompt,
  'supersede-close': supersedeClosePrompt,
  'archive': archivePrompt,
  'attachments': attachmentsPrompt,
  'session': sessionPrompt,
  'pass': passPrompt,
  'identity': identityPrompt,
};

function autolandItem(cell: AutolandCell, repo: string, windowDays: number): CloudBacklogItem {
  return {
    id: `devin-autoland-${sha(`autoland:${cell.kind}`)}`,
    title: TITLES[cell.kind].slice(0, MAX_TITLE_CHARS),
    prompt: PROMPTS[cell.kind](cell, windowDays),
    area: 'devin-autoland',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the Devin autoland journal's recurring adverse
 * outcomes. Total: another repository, a missing journal, an
 * unreadable read or any fold failure yields no items rather than
 * throwing into discovery.
 */
export async function autolandBacklogItems(opts: AutolandItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const journalPath = opts.journalPath ?? join(devinHome(), AUTOLAND_JOURNAL_FILE);
    const nowMs = opts.now ?? Date.now();
    const cutoffMs = nowMs - (opts.windowHours ?? AUTOLAND_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(journalPath, AUTOLAND_TAIL_BYTES);
    // A missing journal is a clean empty source; an unreadable or
    // non-file read means evidence exists that cannot be trusted —
    // fail closed. A truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];
    const { rows } = foldAutolandRows(tail.text, cutoffMs, nowMs);
    if (rows.length === 0) return [];
    const cells = autolandCells(foldAutolandCells(rows), tail.truncated === true);
    const limit = Math.max(1, Math.min(opts.limit ?? AUTOLAND_BACKLOG_MAX_ITEMS, AUTOLAND_ITEM_HARD_MAX));
    const windowDays = Math.round((opts.windowHours ?? AUTOLAND_WINDOW_HOURS) / 24);
    return cells.slice(0, limit).map((cell) => autolandItem(cell, repo, windowDays));
  } catch {
    return [];
  }
}
