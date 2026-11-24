/**
 * Desktop render-crash evidence → self-improvement backlog items.
 *
 * Every caught render crash in the desktop console lands as one JSONL
 * record in <runsDir>/desktop/errors.jsonl: the error boundaries
 * (src/web-ui RouteErrorBoundary, the pane SlotBoundary and
 * DockHelperBoundary) POST surface, message, stack, componentStack and
 * appVersion to /api/verse/desktop-errors, where
 * src/core/verse/desktop-error-report.ts truncates, scrubs secrets and
 * home paths, fingerprints the crash (surface + first stack frame +
 * message, 16 hex chars) and appends the record — deduped per fingerprint
 * inside a 10-minute window, rotated once to errors.1.jsonl past 2 MiB.
 *
 * Until now the ledger's only readers were the dedupe scan inside the
 * writer itself and `phm fleet desktop-errors [--since]`, a grouped
 * report someone had to run and read. The recurring crashes it exists
 * to surface — one fingerprint firing day after day because the pane,
 * route or dock helper behind it was never fixed — never became work.
 *
 * desktopErrorBacklogItems carries the recorded crashes into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling fleet-evidence feeds
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both ledger generations are read through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is touched.
 *  - The writer's own row contract. A record counts only when its own
 *    fields validate — a 16-hex fingerprint, the surface slug charset the
 *    POST validator enforces, a non-empty message and a parseable
 *    timestamp inside the window. Malformed lines are skipped, never
 *    guessed; stack and componentStack are never consumed here (the
 *    prompt points at the ledger for them).
 *  - Recorded text stays recorded text. surface, message and appVersion
 *    are already scrubbed and capped at write time; the fold scrubs and
 *    flattens them again before they reach a prompt, and the message is
 *    quoted as one bounded line — never a fenced blob.
 *  - Recurring means recorded and distinct. A fingerprint cell emits only
 *    at DESKTOP_ERROR_MIN_RECORDS records spanning at least
 *    DESKTOP_ERROR_MIN_DAYS distinct UTC days inside the window — the
 *    server's 10-minute dedupe already collapses same-episode repeats, so
 *    what remains is crashes on separate days, not one bad session. A
 *    burst confined to one UTC day, a single stray crash and a stale
 *    ledger on a console nobody opens all stay out.
 *  - Partial reads under-count, never invent. A missing generation
 *    contributes nothing; an unreadable one is skipped rather than
 *    poisoning the fold, and a truncated tail marks every cell a lower
 *    bound — evidence can only be missing, never fabricated.
 *  - The console and its error boundaries live in this repository
 *    (src/web-ui/, the verse server in src/core/verse/), so items emit
 *    only when the backlog target's repository name is 'phantom' — the
 *    same last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. The item id hashes the fingerprint — never the
 *    counts or timestamps — so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a crash that stops
 *    recurring simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, the recorded message is bounded and labelled, and
 *    the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; fingerprint cells are bounded by distinct crashes in the window. */
export const DESKTOP_ERROR_MAX_ITEMS = 8;
const DESKTOP_ERROR_ITEM_HARD_MAX = 25;
/**
 * Recorded crashes one fingerprint needs inside the window before it
 * counts as recurring — above the writer's own dedupe noise floor.
 */
export const DESKTOP_ERROR_MIN_RECORDS = 3;
/**
 * Distinct UTC days the same fingerprint must span — the recurrence bar:
 * crashes on separate days are an unfixed bug, a one-day burst is an
 * incident the console already survived.
 */
export const DESKTOP_ERROR_MIN_DAYS = 2;
/**
 * Evidence window: a week of console use gives a daily-recurring crash
 * room to prove itself without letting a stale ledger linger (the
 * sibling feeds' 7-day convention).
 */
export const DESKTOP_ERROR_WINDOW_HOURS = 168;
/**
 * Per-generation tail bound. The writer rotates errors.jsonl to
 * errors.1.jsonl once it passes 2 MiB, so 3 MiB covers everything the
 * writer itself produces plus headroom; a larger file is foreign and
 * reads as a stated lower bound.
 */
const DESKTOP_ERROR_TAIL_BYTES = 3 * 1024 * 1024;
/** The ledger directory and file names, the writer's own constants (desktop-error-report.ts). */
const DESKTOP_ERRORS_DIR = 'desktop';
const DESKTOP_ERRORS_FILE = 'errors.jsonl';
const DESKTOP_ERRORS_ROTATED_FILE = 'errors.1.jsonl';
/** The fingerprint shape the writer emits: sha256 hex sliced to 16 chars. */
const FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/;
/** The surface charset the POST validator enforces (SURFACE_PATTERN in desktop-error-report.ts). */
const SURFACE_PATTERN = /^[a-z0-9._:-]{1,64}$/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is bounded upstream; flatten, scrub and cap before it reaches a prompt. */
const MAX_MESSAGE_CHARS = 200;
const MAX_APP_VERSION_CHARS = 64;
/** The fleet's own repository label: console crashes are this install's UI, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface DesktopErrorItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding desktop/errors*.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default DESKTOP_ERROR_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default DESKTOP_ERROR_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated crash record: when it fired and the identity the writer fingerprinted it by. */
export interface DesktopErrorRecord {
  /** The writer's fingerprint — the cell identity. */
  fingerprint: string;
  /** The recorded surface slug (route:<path>, pane:<id>, dock-helper:<name>). */
  surface: string;
  /** The recorded error message, already scrubbed at write time. */
  message: string;
  /** The recorded app version when the writer carried one. */
  appVersion: string | null;
  /** Epoch ms of the record's `at`. */
  atMs: number;
}

/** One recurring crash: a fingerprint's recorded evidence inside the window. */
export interface DesktopErrorCell {
  fingerprint: string;
  /** Surface/message/appVersion of the newest record in the cell. */
  surface: string;
  message: string;
  appVersion: string | null;
  /** Recorded crash rows inside the window (post-write-dedupe). */
  count: number;
  /** Distinct UTC days (YYYY-MM-DD) the fingerprint fired on. */
  days: number;
  firstSeen: string;
  lastSeen: string;
  /** True when a bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const inWindow = (atMs: number, cutoffMs: number, nowMs: number): boolean =>
  atMs >= cutoffMs && atMs <= nowMs;

/**
 * Pure: the valid records of one errors*.jsonl generation. Only rows whose
 * own fields validate count — a fingerprint-shaped id, the surface slug
 * charset, a non-empty message, a string appVersion when present and an
 * in-window timestamp. Malformed JSON, foreign shapes, missing or
 * future-stamped `at` values and untimestamped rows are all skipped, never
 * guessed; stack and componentStack are ignored entirely.
 */
export function parseDesktopErrorRows(text: string, cutoffMs: number, nowMs: number): DesktopErrorRecord[] {
  const out: DesktopErrorRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const fingerprint = r['fingerprint'];
    const surface = r['surface'];
    const message = r['message'];
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) continue;
    if (typeof surface !== 'string' || !SURFACE_PATTERN.test(surface)) continue;
    if (typeof message !== 'string' || message.trim() === '') continue;
    if (r['appVersion'] !== undefined && r['appVersion'] !== null && typeof r['appVersion'] !== 'string') continue;
    const atMs = parseLedgerTs(r['at']);
    if (atMs === null || !inWindow(atMs, cutoffMs, nowMs)) continue;
    out.push({
      fingerprint,
      surface,
      message,
      appVersion: typeof r['appVersion'] === 'string' && r['appVersion'].trim() !== '' ? r['appVersion'] : null,
      atMs,
    });
  }
  return out;
}

/**
 * Pure: fold validated crash records into per-fingerprint cells. Records
 * arrive in file order per generation; the cell's quoted surface, message
 * and appVersion come from the newest record by `at` — fingerprint groups
 * share them by construction, so this only guards a hand-edited ledger.
 * firstSeen/lastSeen are the recorded bounds; `days` counts distinct UTC
 * days, the recurrence measure.
 */
export function foldDesktopErrorCells(records: readonly DesktopErrorRecord[], lowerBound = false): DesktopErrorCell[] {
  const cells = new Map<string, {
    count: number;
    days: Set<string>;
    newest: DesktopErrorRecord | null;
    firstMs: number;
    lastMs: number;
  }>();
  for (const record of records) {
    let cell = cells.get(record.fingerprint);
    if (cell === undefined) {
      cell = { count: 0, days: new Set(), newest: null, firstMs: record.atMs, lastMs: record.atMs };
      cells.set(record.fingerprint, cell);
    }
    cell.count += 1;
    cell.days.add(new Date(record.atMs).toISOString().slice(0, 10));
    if (cell.newest === null || record.atMs >= cell.newest.atMs) cell.newest = record;
    cell.firstMs = Math.min(cell.firstMs, record.atMs);
    cell.lastMs = Math.max(cell.lastMs, record.atMs);
  }
  return [...cells.entries()]
    .map(([fingerprint, cell]) => ({
      fingerprint,
      surface: cell.newest!.surface,
      message: cell.newest!.message,
      appVersion: cell.newest!.appVersion,
      count: cell.count,
      days: cell.days.size,
      firstSeen: new Date(cell.firstMs).toISOString(),
      lastSeen: new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.fingerprint.localeCompare(b.fingerprint));
}

const NO_CHANGE = 'If the window has rolled forward, the crashes were a one-off burst the console already survived, they came from a pane or route that no longer exists, or the cause is owner-only state (a credential, a host service, a pinned file) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the report-only gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is desktop/errors.jsonl (plus the single errors.1.jsonl rotation) under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the crash ledger every caught render error appends to through POST /api/verse/desktop-errors. `phm fleet desktop-errors --since 7d --json` prints the same records grouped by fingerprint. Until this feed the ledger had no trend fold — only that report and the writer\'s own 10-minute dedupe read it.';

function seenText(cell: DesktopErrorCell): string {
  return cell.firstSeen === cell.lastSeen
    ? ` First recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: DesktopErrorCell): string {
  return cell.lowerBound ? ' A ledger tail was truncated, so these counts are a lower bound.' : '';
}

function versionText(cell: DesktopErrorCell): string {
  return cell.appVersion === null ? '' : ` Recorded app version: '${fieldText(cell.appVersion, MAX_APP_VERSION_CHARS)}'.`;
}

function desktopErrorPrompt(cell: DesktopErrorCell): string {
  const surface = fieldText(cell.surface, 64);
  const message = fieldText(cell.message, MAX_MESSAGE_CHARS);
  return [
    `The Phantom desktop console keeps crashing on '${surface}' — ${cell.count} recorded render crash(es) of one fingerprint across ${cell.days} distinct days inside the window, so whatever sits behind that surface was never fixed.`,
    '',
    `The crash ledger recorded ${cell.count} row(s) for fingerprint ${cell.fingerprint}: surface '${surface}', message "${message}".${versionText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The reporters are this repository's own error boundaries — src/web-ui/components/primitives/RouteErrorBoundary.tsx wraps every route, the pane SlotBoundary in src/web-ui/routes/verse/shell/slots.tsx wraps each pane, and DockHelperBoundary wraps dock helpers — while the verse endpoint that records them is src/core/verse/desktop-error-report.ts. The surface names the route or pane that tripped: 'route:<dot.path>' for a whole view, 'pane:<id>' for one pane, 'dock-helper:<name>' for a dock helper. What this repository owns is the component tree behind that surface: reproduce the render path the recorded stack frames name (the ledger rows carry the full stack and componentStack the prompt does not quote), find the state or prop that throws, and fix it — or, when the crash is a deliberate error boundary doing its job on genuinely broken upstream data, tighten what the boundary reports instead of the component.`,
    '',
    `Find the crashing component: join the fingerprint to its ledger rows for the stack, map the surface to the boundary and route, and reproduce under the web component tests in src/web-ui. Fix what lives here; if the cause is owner-only state, host services or pinned machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function desktopErrorItem(cell: DesktopErrorCell, repo: string): CloudBacklogItem {
  const surface = fieldText(cell.surface, 64) || 'unknown';
  const id = `fleet-desktop-errors-${createHash('sha256').update(`desktop-error:${cell.fingerprint}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `The desktop console keeps crashing on ${surface}`.slice(0, MAX_TITLE_CHARS),
    prompt: desktopErrorPrompt(cell),
    area: 'desktop-errors',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for recurring desktop render crashes. Total: any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function desktopErrorBacklogItems(opts: DesktopErrorItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? DESKTOP_ERROR_WINDOW_HOURS) * 3_600_000;
    const dir = join(runsDir, DESKTOP_ERRORS_DIR);
    const generations = await Promise.all(
      [DESKTOP_ERRORS_ROTATED_FILE, DESKTOP_ERRORS_FILE].map((name) =>
        readLedgerTail(join(dir, name), DESKTOP_ERROR_TAIL_BYTES)),
    );
    const records: DesktopErrorRecord[] = [];
    let lowerBound = false;
    let readAny = false;
    for (const tail of generations) {
      if (tail.state !== 'read') continue;
      readAny = true;
      lowerBound = lowerBound || tail.truncated === true;
      records.push(...parseDesktopErrorRows(tail.text, cutoffMs, nowMs));
    }
    if (!readAny || records.length === 0) return [];
    const cells = foldDesktopErrorCells(records, lowerBound)
      .filter((cell) => cell.count >= DESKTOP_ERROR_MIN_RECORDS && cell.days >= DESKTOP_ERROR_MIN_DAYS);
    const limit = Math.max(1, Math.min(opts.limit ?? DESKTOP_ERROR_MAX_ITEMS, DESKTOP_ERROR_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => desktopErrorItem(cell, repo));
  } catch {
    return [];
  }
}
