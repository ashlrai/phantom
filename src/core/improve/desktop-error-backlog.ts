/**
 * Desktop render-crash journal recurring evidence →
 * self-improvement backlog items.
 *
 * Every error boundary in the desktop console POSTs one record to
 * /api/verse/desktop-errors, and recordDesktopError
 * (src/core/verse/desktop-error-report.ts) appends it — truncated,
 * secret-scrubbed and home-path-redacted at write time — to
 * <runsDir>/desktop/errors.jsonl as one {at, surface, message, stack?,
 * componentStack?, appVersion?, fingerprint} JSONL line per crash,
 * deduped per fingerprint inside a ten-minute window and bounded by a
 * single rotation to errors.1.jsonl once the live file passes 2 MiB.
 * `fingerprint` is the writer's own crash identity: sha256 of the
 * surface, the first stack frame and the message, sliced to 16 hex
 * chars — the same crash keeps one identity across sessions and app
 * versions.
 *
 * Until now the ledger's only reader was `ashlr fleet desktop-errors`
 * (src/cli/fleet-desktop-errors.ts), a report someone had to run —
 * default 24-hour window, 50-group cap, no recurrence fold: a crash
 * fingerprint firing day after day — a pane or view in this repo's own
 * console that keeps throwing — looked like one row in a list someone
 * had to open, never a pattern, never work. The console is the fleet's
 * own surface, so its recurring crash cells are direct evidence.
 *
 * desktopErrorBacklogItems carries the same ledger into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling fleet-evidence feeds
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The live file and its single rotation are each read
 *    once through readLedgerTail's bounded no-follow tail; nothing is
 *    written and no lock, process or network is touched. A missing
 *    file is the writer's normal first-run state; an unreadable one
 *    yields no items while the other still folds — unknown stays
 *    unknown, never a guessed tally — and a truncated tail folds the
 *    retained rows with the prompts stating the counts as lower
 *    bounds.
 *  - Rows count only under the writer's contract: a parseable `at`, a
 *    non-empty `fingerprint`/`surface`/`message` string, and
 *    `stack`/`componentStack`/`appVersion` as string-or-absent — the
 *    same fields normaliseDesktopError accepts at ingest.
 *    Malformed lines are counted, never guessed.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a fingerprint emits only when its in-window
 *    records reach DESKTOP_ERROR_MIN_UNITS across
 *    DESKTOP_ERROR_MIN_DAYS distinct UTC days — one crash is a bug
 *    report, a one-day storm is a session someone closed, recurrence
 *    across days is a defect that keeps firing. The window is anchored
 *    on the clock with the sibling feeds' future-skew allowance, and
 *    every record is already a post-dedupe event (the writer drops a
 *    repeat fingerprint inside ten minutes), so units count distinct
 *    sightings, not a tight loop.
 *  - The evidence is this install's console: every record describes a
 *    crash in the desktop app this fleet runs, so items emit only when
 *    the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids key on the fingerprint — the
 *    writer's own crash identity — never the counts or timestamps, so
 *    a refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new; a crash that gets fixed simply stops
 *    re-adding.
 *  - Every journal string is untrusted text even though the writer
 *    scrubbed it: surface, message and stack text are scrubbed,
 *    flattened and capped again before they reach a prompt, and cell
 *    identity stays the writer's fingerprint, never journal text.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cap bounds the open-ended fingerprint cells. */
export const DESKTOP_ERROR_BACKLOG_MAX_ITEMS = 12;
const DESKTOP_ERROR_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const DESKTOP_ERROR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const DESKTOP_ERROR_FUTURE_SKEW_MS = 60_000;
/** In-window records a fingerprint needs before its recurrence counts. */
export const DESKTOP_ERROR_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const DESKTOP_ERROR_MIN_DAYS = 2;
/**
 * Bounded tail per ledger file. The writer rotates the live file to
 * errors.1.jsonl once it passes 2 MiB, so 3 MiB retains every row the
 * writer can keep plus slack; a contract-violating larger file still
 * folds its newest rows with lower-bound counts.
 */
export const DESKTOP_ERROR_FILE_TAIL_BYTES = 3 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The writer's ingest contract bounds surface to 64 chars; a longer string is off-contract. */
const MAX_SURFACE_CHARS = 64;
/** The writer's fingerprint is 16 hex chars; accept a bounded string and hash it for identity. */
const MAX_FINGERPRINT_CHARS = 64;
/** The first stack frame quoted inside one prompt is capped tighter than journal text. */
const STACK_FRAME_MAX = 200;
/** The fleet's own repository label: desktop evidence is this install's console, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger file names the writer produces under <runsDir>/desktop/. */
const LIVE_FILE = 'errors.jsonl';
const ROTATED_FILE = 'errors.1.jsonl';

export interface DesktopErrorItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding desktop/errors.jsonl; $ASHLR_RUNS_DIR wins when set (default: <home>/.ashlr-runs). */
  runsDir?: string;
  /** Desktop ledger directory override (default: <runsDir>/desktop); tests only. */
  desktopDir?: string;
  /** Home for the runs-dir default; os.homedir() when unset. */
  homeDir?: string;
  /** Most items one call emits (default DESKTOP_ERROR_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default DESKTOP_ERROR_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated crash record inside the evidence window. */
export interface DesktopErrorRow {
  atMs: number;
  utcDay: string;
  fingerprint: string;
  surface: string;
  message: string;
  appVersion: string | null;
  /** The first `at ...` frame of stack, else componentStack — the writer's own localization hint. */
  stackFrame: string;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The writer's firstStackFrame: the first `at ...` line of a stack, trimmed. */
function firstStackFrame(stack: string | undefined): string {
  if (stack === undefined) return '';
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('at ')) return trimmed;
  }
  return '';
}

const optionalString = (value: Record<string, unknown>, key: string): string | undefined | null =>
  value[key] === undefined ? undefined : typeof value[key] === 'string' ? (value[key] as string) : null;

/**
 * Pure: validate one parsed ledger line against the writer's record
 * contract — the same fields recordDesktopError stores and
 * parseLedgerLine reads back, plus the surface bound and optional
 * string fields normaliseDesktopError enforces at ingest. Anything
 * else is not a crash row.
 */
export function parseDesktopErrorEntry(value: unknown): DesktopErrorRow | null {
  if (!isRecord(value)) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const fingerprint = value['fingerprint'];
  if (typeof fingerprint !== 'string' || fingerprint === '' || fingerprint.length > MAX_FINGERPRINT_CHARS) return null;
  const surface = value['surface'];
  if (typeof surface !== 'string' || surface === '' || surface.length > MAX_SURFACE_CHARS) return null;
  const message = value['message'];
  if (typeof message !== 'string' || message === '') return null;
  const stack = optionalString(value, 'stack');
  const componentStack = optionalString(value, 'componentStack');
  const appVersion = optionalString(value, 'appVersion');
  if (stack === null || componentStack === null || appVersion === null) return null;
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    fingerprint,
    surface,
    message,
    appVersion: appVersion ?? null,
    stackFrame: firstStackFrame(stack) || firstStackFrame(componentStack),
  };
}

/**
 * Pure: parse one ledger file's text into validated rows plus the
 * count of lines that were not on-contract records — malformed JSON
 * and off-contract rows are counted, never guessed.
 */
export function parseDesktopErrorLedger(text: string): { rows: DesktopErrorRow[]; invalidRows: number } {
  const rows: DesktopErrorRow[] = [];
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
    const row = parseDesktopErrorEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** One fingerprint's recurring crash tally across the in-window rows. */
export interface DesktopErrorCell {
  fingerprint: string;
  /** Surface and message of the newest in-window record (the writer's fingerprint makes them constant per cell). */
  surface: string;
  message: string;
  /** Newest recorded appVersion, or null when no record carried one. */
  appVersion: string | null;
  /** Newest record's first stack frame, or '' when none recorded one. */
  stackFrame: string;
  /** Post-dedupe crash records carrying this fingerprint inside the window. */
  units: number;
  /** Distinct UTC days those records fall on. */
  days: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/**
 * Pure: fold validated rows into per-fingerprint tallies. Every record
 * is a crash — the writer has no non-adverse vocabulary — so all
 * in-window rows count toward their fingerprint's recurrence.
 */
export function foldDesktopErrorEvidence(
  rows: readonly DesktopErrorRow[],
  opts: { nowMs: number; windowMs?: number },
): { cells: DesktopErrorCell[]; records: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? DESKTOP_ERROR_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, DesktopErrorCell>();
  let inWindow = 0;
  let outsideWindow = 0;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > opts.nowMs + DESKTOP_ERROR_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    let cell = cells.get(row.fingerprint);
    if (cell === undefined) {
      cell = {
        fingerprint: row.fingerprint,
        surface: row.surface,
        message: row.message,
        appVersion: row.appVersion,
        stackFrame: row.stackFrame,
        units: 0,
        days: new Set(),
        firstAtMs: Infinity,
        lastAtMs: -Infinity,
      };
      cells.set(row.fingerprint, cell);
    }
    cell.units += 1;
    cell.days.add(row.utcDay);
    cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
    // Rows arrive file-order, not time-order; the newest record owns the
    // display fields so the prompt quotes the latest sighting.
    if (row.atMs >= cell.lastAtMs) {
      cell.surface = row.surface;
      cell.message = row.message;
      cell.appVersion = row.appVersion ?? cell.appVersion;
      cell.stackFrame = row.stackFrame;
    }
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= DESKTOP_ERROR_MIN_UNITS && cell.days.size >= DESKTOP_ERROR_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.fingerprint.localeCompare(b.fingerprint));
  return { cells: recurring, records: inWindow, outsideWindow };
}

/** The evidence pointers every prompt shares; the ledger, its writer and its existing reader are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is desktop/errors.jsonl (and its single errors.1.jsonl rotation) under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): recordDesktopError in src/core/verse/desktop-error-report.ts appends one {at, surface, message, stack?, componentStack?, appVersion?, fingerprint} line per crash the console reports through POST /api/verse/desktop-errors — the web-ui error boundaries report via src/web-ui/lib/report-desktop-error.ts — after truncating, secret-scrubbing and home-path redacting every string, deduping a fingerprint inside a ten-minute window and rotating the live file to errors.1.jsonl once it passes 2 MiB. Until this feed the ledger\'s only reader was `ashlr fleet desktop-errors`, a report someone had to run.';

const NO_CHANGE = 'If the window has rolled forward, the crashes were a one-off burst a restart or deploy already fixed, or the cause is owner-side or pinned ops machinery — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  const notes: string[] = [];
  if (truncatedFiles > 0) notes.push(`${truncatedFiles} ledger tail(s) dropped older rows, so every count is a lower bound`);
  if (unreadableFiles > 0) notes.push(`${unreadableFiles} ledger file(s) unreadable`);
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (outsideWindow > 0) notes.push(`${outsideWindow} rows outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function surfaceText(surface: string): string {
  return fieldText(surface, MAX_SURFACE_CHARS) || 'unknown';
}

function crashPrompt(cell: DesktopErrorCell, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): string {
  const surface = surfaceText(cell.surface);
  const message = fieldText(cell.message) || 'no message recorded';
  const frame = fieldText(cell.stackFrame, STACK_FRAME_MAX);
  const version = cell.appVersion === null ? '' : ` Latest app version recorded: '${fieldText(cell.appVersion, 128)}'.`;
  const frameText = frame === '' ? 'No stack frame was recorded.' : ` First stack frame: '${frame}'.`;
  return [
    `Phantom's desktop console keeps crashing on surface '${surface}' — ${cell.units} crash records across ${cell.days.size} UTC days inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each record is one post-dedupe crash sighting: the console's error boundaries report through src/web-ui/lib/report-desktop-error.ts to POST /api/verse/desktop-errors, and recordDesktopError stores {at, surface, message, stack?, componentStack?, appVersion?, fingerprint} after truncating, secret-scrubbing and home-path redacting it; the fingerprint is sha256(surface + first stack frame + message), so this cell is one crash identity, not a class of lookalikes. Recorded message: '${message}'.${frameText}${version}${spanText(cell.firstAtMs, cell.lastAtMs)}${coverageNote(truncatedFiles, invalidRows, unreadableFiles, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find the crash: the surface names the view or pane whose error boundary caught it — grep the surface literal under src/web-ui (surfaces are the closed id vocabulary report-desktop-error emits). Reproduce against a scratch home: run the web-ui dev server or the desktop build, open that surface and watch for the throw. The message and first stack frame localize the fault — check for an unguarded null/undefined path, a fetch or subscription that rejects unhandled, or state the surface assumes but the fleet API no longer guarantees. If the crash is already fixed on the default branch and the window's rows predate the fix — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function desktopErrorItem(cell: DesktopErrorCell, repo: string, truncatedFiles: number, invalidRows: number, unreadableFiles: number, outsideWindow: number): CloudBacklogItem {
  const surface = surfaceText(cell.surface);
  return {
    id: `desktop-error-${sha(`desktop-error:${cell.fingerprint}`)}`,
    title: `Desktop surface '${surface}' keeps crashing`.slice(0, MAX_TITLE_CHARS),
    prompt: crashPrompt(cell, truncatedFiles, invalidRows, unreadableFiles, outsideWindow),
    area: 'desktop-console',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the desktop render-crash journal's recurring
 * evidence. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function desktopErrorBacklogItems(opts: DesktopErrorItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const dir = opts.desktopDir ?? join(runsDir, 'desktop');
    if (typeof dir !== 'string' || dir === '') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? DESKTOP_ERROR_WINDOW_MS;

    // The rotation is the older file; the live file is authoritative.
    // Both are read unconditionally — a missing one is the writer's
    // normal state (no rotation yet, or a fresh runs dir).
    const reads = await Promise.all(
      [ROTATED_FILE, LIVE_FILE].map((name) => readLedgerTail(join(dir, name), DESKTOP_ERROR_FILE_TAIL_BYTES)),
    );
    const rows: DesktopErrorRow[] = [];
    let invalidRows = 0;
    let truncatedFiles = 0;
    let unreadableFiles = 0;
    let readFiles = 0;
    for (const read of reads) {
      if (read.state !== 'read') {
        // A file that vanished between stat and open is a non-event;
        // anything else unreadable is stated, never guessed.
        if (read.state !== 'missing') unreadableFiles += 1;
        continue;
      }
      readFiles += 1;
      if (read.truncated) truncatedFiles += 1;
      const parsed = parseDesktopErrorLedger(read.text);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    }
    if (readFiles === 0) return [];

    const folded = foldDesktopErrorEvidence(rows, { nowMs, windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(desktopErrorItem(cell, repo, truncatedFiles, invalidRows, unreadableFiles, folded.outsideWindow));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? DESKTOP_ERROR_BACKLOG_MAX_ITEMS, DESKTOP_ERROR_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
