/**
 * Fleet custody spawns ledger evidence → self-improvement backlog items.
 *
 * Every engine spawn runEngine (src/core/run/engines.ts) makes appends one
 * value-free custody record through appendCustodyRecord
 * (src/core/run/custody-ledger.ts) to ~/.ashlr/custody/spawns.jsonl —
 * {schema, at, wrapped, engine, preflight_exit} plus `reason` on unwrapped
 * rows, the closed UnwrappedReason vocabulary decidePhantomCustody
 * (src/core/run/phantom-custody.ts) names: whether the spawn ran under
 * `phantom exec` and, when it did not, which custody gate refused —
 * not-initialized (the cwd has no .phantom.toml), phantom-not-installed,
 * phantom-disabled, self-authenticating-engine, worktree-namespace (a
 * linked git worktree opens a separate, empty vault until the opt-in
 * source binding lands), preflight-blocked / preflight-unavailable (the
 * strict ASHLR_PHANTOM_PREFLIGHT=1 verdict), connection-string-blocked or
 * unknown. The file is capped at 4 MiB and rotates once to
 * spawns.jsonl.1; writes and reads are bounded and refuse symlinks.
 *
 * Until now the ledger had no trend reader: `phm status`'s custody
 * section folds readCustodySummary into point-in-time counts and the
 * receipt timeline reads readCustodyWindow for a single run's window —
 * reports someone had to run — so a fleet whose spawns keep missing
 * custody for the same reason (checkouts never initialized, the phantom
 * binary missing on a host, linked-worktree spawns hitting the
 * vault-namespace gap, the strict preflight refusing or unavailable)
 * looked like ordinary current-state numbers, never work.
 *
 * custodyBacklogItems carries the recorded unwrapped reasons into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both ledger generations are read through readLedgerTail's
 *    bounded no-follow tail at the writer's own read bound; nothing is
 *    written and no network is touched.
 *  - Recorded rows only. A row counts only under the writer's contract —
 *    schema 1, a parseable `at`, boolean wrapped, an engine matching the
 *    writer's ENGINE_SHAPE, preflight_exit null or an integer in
 *    [-1, 255], and on unwrapped rows a reason in the closed
 *    UNWRAPPED_REASONS vocabulary. Malformed lines are skipped, never
 *    guessed.
 *  - By-design rows never emit. 'self-authenticating-engine' is the
 *    writer's deliberate verdict for engines that authenticate with their
 *    own login — wrapping them is unnecessary and fatal in worktrees
 *    without .phantom.toml — and 'phantom-disabled' records the
 *    owner-side phantom.enabled posture every spawn on a disabled install
 *    writes, which no repository change can flip. Both still count
 *    toward the per-engine spawn totals the prompts quote.
 *  - Recurring means recorded across days. An (engine, reason) cell emits
 *    only at CUSTODY_MIN_ROWS unwrapped rows spanning CUSTODY_MIN_DAYS
 *    distinct UTC days inside the window, so one bad afternoon or a
 *    single misconfigured checkout never queues a session.
 *  - Truncation is stated, never hidden. When a generation's bounded tail
 *    cut older rows, the cell's counts are a lower bound and the prompt
 *    says so (the fleet-controller feed's convention).
 *  - Items emit only for the fleet's own repository — the ledger carries
 *    no repo column and describes this install's spawn machinery.
 *  - Dedup is downstream. The item id hashes the cell identity (engine +
 *    reason — never counts or timestamps), so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; a gap that
 *    closes simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, engine strings are shape-bounded by the writer's
 *    contract, reason text is the closed vocabulary, and the brief carries
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { UNWRAPPED_REASONS, type UnwrappedReason } from '../run/phantom-custody.js';
import {
  CUSTODY_LEDGER_MAX_READ_BYTES,
  CUSTODY_LEDGER_SCHEMA,
  custodyLedgerPath,
} from '../run/custody-ledger.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by engine×reason diversity. */
export const CUSTODY_BACKLOG_MAX_ITEMS = 8;
const CUSTODY_ITEM_HARD_MAX = 25;
/** Evidence window: a week of spawns gives recurring custody gaps room without letting stale evidence linger. */
export const CUSTODY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Adverse unwrapped rows one cell needs inside the window before it counts as recurring. */
export const CUSTODY_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const CUSTODY_MIN_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Engine strings already match the writer's ENGINE_SHAPE (64 chars, safe charset); flatten, scrub and cap at that bound. */
const MAX_ENGINE_CHARS = 64;
/** The fleet's own repository label: custody evidence is this install's spawn machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's engine-name contract, mirrored from custody-ledger.ts's private ENGINE_SHAPE. */
const ENGINE_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
/** The writer's closed unwrapped-reason vocabulary. */
const UNWRAPPED_REASON_SET: ReadonlySet<string> = new Set(UNWRAPPED_REASONS);
/**
 * Unwrapped verdicts that are deliberate posture, never evidence:
 * 'self-authenticating-engine' is by design (those engines authenticate
 * with their own login — wrapping is unnecessary and fatal without
 * .phantom.toml), and 'phantom-disabled' records the owner-side
 * phantom.enabled config every spawn on a disabled install writes.
 */
const BY_DESIGN_REASONS: ReadonlySet<UnwrappedReason> = new Set(['self-authenticating-engine', 'phantom-disabled']);

export interface CustodyItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /**
   * Path to the live spawns.jsonl; its `.1` sibling is read as the rotated
   * generation (the writer renames spawns.jsonl → spawns.jsonl.1 past the
   * 4 MiB cap). Default: the writer's own custodyLedgerPath() —
   * ~/.ashlr/custody/spawns.jsonl, homedir-rooted; $ASHLR_HOME does not
   * relocate it.
   */
  ledgerPath?: string;
  /** Evidence window in ms (default CUSTODY_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default CUSTODY_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated custody row: when the spawn happened, which engine, and the recorded verdict. */
export interface CustodySpawnRow {
  atMs: number;
  /** UTC day (YYYY-MM-DD) of atMs — the recurrence bar's day spread. */
  utcDay: string;
  engine: string;
  wrapped: boolean;
  /** The recorded unwrapped reason; null on wrapped rows. */
  reason: UnwrappedReason | null;
}

/** One (engine, reason) cell: recurring unwrapped spawns plus the engine's total spawn context. */
export interface CustodyCell {
  /** Sanitized recorded engine name. */
  engine: string;
  /** The adverse unwrapped reason the cell groups on. */
  reason: UnwrappedReason;
  /** Adverse unwrapped rows for this cell inside the window. */
  rows: number;
  /** Distinct UTC days those rows span. */
  days: number;
  /** All validated in-window spawns recorded for this engine — wrapped, benign and adverse — the denominator the prompt quotes. */
  engineSpawns: number;
  /** Wrapped in-window spawns for this engine. */
  engineWrapped: number;
  /** ISO bounds of the cell's recorded rows. */
  firstSeen: string;
  lastSeen: string;
  /** True when a generation's bounded tail cut older rows: counts are a lower bound. */
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

/**
 * Pure: one ledger line → a validated row, or null when it fails the
 * writer's contract. Mirrors appendCustodyRecord's emitted shape: schema
 * 1, ISO `at`, boolean wrapped, ENGINE_SHAPE engine, preflight_exit null
 * or a bounded integer, and on unwrapped rows a reason in the closed
 * vocabulary. Extra fields are ignored for forward compatibility.
 */
export function parseCustodySpawnLine(line: string): CustodySpawnRow | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['schema'] !== CUSTODY_LEDGER_SCHEMA) return null;
  const atMs = parseLedgerTs(row['at']);
  if (atMs === null) return null;
  const wrapped = row['wrapped'];
  if (typeof wrapped !== 'boolean') return null;
  const engine = row['engine'];
  if (typeof engine !== 'string' || !ENGINE_SHAPE.test(engine)) return null;
  const exit = row['preflight_exit'];
  if (!(exit === null || (typeof exit === 'number' && Number.isSafeInteger(exit) && exit >= -1 && exit <= 255))) return null;
  const utcDay = new Date(atMs).toISOString().slice(0, 10);
  if (wrapped) return { atMs, utcDay, engine, wrapped: true, reason: null };
  const reason = row['reason'];
  if (typeof reason !== 'string' || !UNWRAPPED_REASON_SET.has(reason)) return null;
  return { atMs, utcDay, engine, wrapped: false, reason: reason as UnwrappedReason };
}

/**
 * Pure: the validated custody rows of one ledger generation's text.
 * Contract rows outside the window are skipped silently; malformed or
 * off-contract lines are counted, never guessed.
 */
export function parseCustodySpawnRows(
  text: string,
  cutoffMs: number,
  nowMs: number,
): { rows: CustodySpawnRow[]; invalid: number } {
  const rows: CustodySpawnRow[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseCustodySpawnLine(line);
    if (row === null) { invalid += 1; continue; }
    if (row.atMs < cutoffMs || row.atMs > nowMs) continue;
    rows.push(row);
  }
  return { rows, invalid };
}

/**
 * Pure: fold validated custody rows into per-(engine, reason) cells over
 * the adverse unwrapped vocabulary. Wrapped rows and by-design unwrapped
 * verdicts never form cells but still count toward each engine's spawn
 * totals — the denominator the prompts quote. A cell carries its UTC-day
 * spread so the recurring bar can require recurrence across days.
 */
export function foldCustodyCells(rows: readonly CustodySpawnRow[], lowerBound = false): CustodyCell[] {
  const cells = new Map<string, {
    engine: string;
    reason: UnwrappedReason;
    rows: number;
    days: Set<string>;
    firstMs: number;
    lastMs: number;
  }>();
  const engineSpawns = new Map<string, number>();
  const engineWrapped = new Map<string, number>();
  for (const row of rows) {
    const engine = fieldText(row.engine, MAX_ENGINE_CHARS) || 'unknown';
    engineSpawns.set(engine, (engineSpawns.get(engine) ?? 0) + 1);
    if (row.wrapped) {
      engineWrapped.set(engine, (engineWrapped.get(engine) ?? 0) + 1);
      continue;
    }
    const reason = row.reason;
    if (reason === null || BY_DESIGN_REASONS.has(reason)) continue;
    const key = `${engine} ${reason}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { engine, reason, rows: 0, days: new Set(), firstMs: row.atMs, lastMs: row.atMs };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      engine: cell.engine,
      reason: cell.reason,
      rows: cell.rows,
      days: cell.days.size,
      engineSpawns: engineSpawns.get(cell.engine) ?? 0,
      engineWrapped: engineWrapped.get(cell.engine) ?? 0,
      firstSeen: new Date(cell.firstMs).toISOString(),
      lastSeen: new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.rows - a.rows || a.engine.localeCompare(b.engine) || a.reason.localeCompare(b.reason));
}

/** What each unwrapped reason means at the custody decision — the gate that refused the wrap. */
const REASON_TEXT: Record<UnwrappedReason, string> = {
  'not-initialized': 'the spawn\'s working directory had no .phantom.toml, so phantom had no vault to wrap into',
  'phantom-not-installed': 'the phantom CLI was not on PATH where the spawn expected it',
  'phantom-disabled': 'phantom custody is off in this install\'s config (phantom.enabled) — a posture row, never emitted as work',
  'self-authenticating-engine': 'the engine authenticates with its own login, so custody deliberately does not wrap it — a by-design row, never emitted as work',
  'worktree-namespace': 'a linked git worktree opens a separate, empty vault until the opt-in source binding lands',
  'preflight-blocked': 'the strict preflight (ASHLR_PHANTOM_PREFLIGHT=1) returned a blocking verdict',
  'preflight-unavailable': 'the strict preflight could not run to a verdict',
  'connection-string-blocked': 'a connection string in the spawn\'s environment blocked the wrap',
  'unknown': 'the custody decision fell through to the unclassified reason',
};

const NO_CHANGE = 'If the window has rolled forward, the spawns were a one-off burst the fleet recovered from, the unwrapped verdicts are deliberate owner-side posture (phantom.enabled off, self-authenticating engines, pinned ops machinery, host install state or config only the owner can change) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-ledger gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is spawns.jsonl under the custody directory of the Phantom state home (~/.ashlr/custody — homedir-rooted; $ASHLR_HOME does not relocate it), plus its one rotated generation spawns.jsonl.1 — the fleet custody ledger appendCustodyRecord in src/core/run/custody-ledger.ts writes one value-free row per engine spawn from runEngine in src/core/run/engines.ts, capped at 4 MiB with a single rotation. Until this feed the ledger had no trend reader: `phm status`\'s custody section folds readCustodySummary into point-in-time counts and the receipt timeline reads readCustodyWindow for a single run\'s window — reports someone had to run — so recurring unwrapped reasons never became work.';

interface Coverage {
  invalidRows: number;
  unreadableFiles: number;
}

function coverageNote(coverage: Coverage): string {
  const notes: string[] = [];
  if (coverage.invalidRows > 0) notes.push(`${coverage.invalidRows} malformed or off-contract lines dropped`);
  if (coverage.unreadableFiles > 0) notes.push(`${coverage.unreadableFiles} ledger generation(s) unreadable`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function seenText(cell: CustodyCell): string {
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: CustodyCell): string {
  return cell.lowerBound ? ' The ledger tail was truncated, so these counts are a lower bound.' : '';
}

function custodyPrompt(cell: CustodyCell, coverage: Coverage): string {
  const context = cell.engineSpawns > 0
    ? ` — ${cell.rows} of ${cell.engineSpawns} recorded in-window spawns for that engine, ${cell.engineWrapped} of them wrapped`
    : '';
  return [
    `Phantom's engine spawns keep missing secrets custody — ${cell.rows} recorded '${cell.reason}' unwrapped spawn(s) for engine '${cell.engine}' across ${cell.days} UTC day(s) inside the window${context}, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one spawn runEngine recorded unwrapped because decidePhantomCustody named this reason: ${REASON_TEXT[cell.reason]}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `The custody decision and the ledger are this repository's — src/core/run/phantom-custody.ts decides the verdict and src/core/run/custody-ledger.ts owns the record — while phantom install state, ~/.ashlr config, host PATH and owner posture are owner-side. What this repository owns is the coverage around them: which spawn paths reach runEngine without an initialized checkout, the linked-worktree vault-namespace binding, the strict preflight's checks and failure modes, and the classification that names the reason.`,
    '',
    `Find why engine '${cell.engine}' keeps spawning unwrapped for '${cell.reason}': join the spawn paths that reach runEngine and check whether the cause is init coverage, the pending source binding, a preflight check, or a classification gap this repository owns — or report no-change naming owner-side or pinned causes. ${NO_CHANGE}`,
  ].join('\n');
}

function custodyItem(cell: CustodyCell, repo: string, coverage: Coverage): CloudBacklogItem {
  const id = `fleet-custody-${createHash('sha256').update(`custody:${cell.engine}:${cell.reason}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `Engine '${cell.engine}' keeps spawning without Phantom custody (${cell.reason})`.slice(0, MAX_TITLE_CHARS),
    prompt: custodyPrompt(cell, coverage),
    area: 'custody',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the custody spawns ledger's recurring (engine,
 * reason) cells. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function custodyBacklogItems(opts: CustodyItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const livePath = typeof opts.ledgerPath === 'string' && opts.ledgerPath !== '' ? opts.ledgerPath : custodyLedgerPath();
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowMs ?? CUSTODY_WINDOW_MS);

    // Both generations are read unconditionally — a missing one is the
    // writer's normal state (fresh install, or no rotation yet).
    const reads = await Promise.all(
      [livePath, `${livePath}.1`].map((path) => readLedgerTail(path, CUSTODY_LEDGER_MAX_READ_BYTES)),
    );
    const rows: CustodySpawnRow[] = [];
    let invalidRows = 0;
    let truncatedFiles = 0;
    let unreadableFiles = 0;
    for (const read of reads) {
      if (read.state !== 'read') {
        // A file that vanished between stat and open is a non-event;
        // anything else unreadable is stated, never guessed.
        if (read.state !== 'missing') unreadableFiles += 1;
        continue;
      }
      if (read.truncated) truncatedFiles += 1;
      const parsed = parseCustodySpawnRows(read.text, cutoffMs, nowMs);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalid;
    }
    if (rows.length === 0) return [];

    const lowerBound = truncatedFiles > 0;
    const cells = foldCustodyCells(rows, lowerBound)
      .filter((cell) => cell.rows >= CUSTODY_MIN_ROWS && cell.days >= CUSTODY_MIN_DAYS);
    if (cells.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? CUSTODY_BACKLOG_MAX_ITEMS, CUSTODY_ITEM_HARD_MAX));
    const coverage: Coverage = { invalidRows, unreadableFiles };
    return cells.slice(0, limit).map((cell) => custodyItem(cell, repo, coverage));
  } catch {
    return [];
  }
}
