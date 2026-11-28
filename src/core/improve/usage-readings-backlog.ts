/**
 * <runs>/queue/usage-readings.log usage-signal journal →
 * self-improvement backlog items.
 *
 * Every `phm usage signal --directory <dir> --event <event>` pass runs
 * writeUsageSignal (src/core/fabric/usage-signal-writer.ts), which
 * reads each selected pool through its configured reader and appends
 * one {pool, pctUsed, resetAt, source, fetchedAt, writtenAt, event,
 * burnRatePctPerHour, projected100At, cutActive} UsageReading row per
 * pool to this append-only file under the private usage store
 * (mode 0600, capped at 8 MiB). The event vocabulary is closed:
 * 'dispatch-start', 'pr-merge', '429', 'limit-message',
 * 'manual-reading' and 'hourly' are the triggers that caused the
 * pass; pctUsed is the provider-reported used-percent (null when the
 * probe ran but the meter stayed unread), resetAt the allowance
 * window's reset instant, and event '429'/'limit-message' rows mark
 * passes a provider limit signal triggered.
 *
 * Until now the journal's only readers were display and point-in-time
 * surfaces — lane-console and mission-control projections, the
 * reward-feed and growth series readers, and `phm fleet usage-audit`
 * (src/core/fleet/usage-motion-audit.ts), a report someone had to run
 * — so a journal the strict writer itself refuses to append to, a
 * pool whose meter stayed unread day after day, a fleet whose
 * providers kept answering 429s, or a meter that kept reporting less
 * used-percent inside one reset window never became work.
 * usageReadingsBacklogItems carries the same rows into
 * discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing or unreadable file yields no items.
 *  - The writer's contract is strict: journal() validates EVERY line
 *    of the whole file on every append and throws 'Usage journal is
 *    invalid' on the first unparsable line, non-contract row, or
 *    per-pool writtenAt regression ('Usage journal moved
 *    backwards'), and throws 'Usage journal is incomplete' on a torn
 *    final append. One bad line therefore bricks every future
 *    `phm usage signal` until the file is repaired — so any scanned
 *    line that would trip that validation is itself the adverse
 *    evidence, emitted once as a journal-corruption item. The tail is
 *    bounded, so corruption older than the retained bytes still bricks
 *    the writer unseen; the prompt says so.
 *  - Recurring means recorded across windows and days: a probe-miss,
 *    limit-signal or meter-regression cell emits only at
 *    USAGE_READINGS_MIN_ROWS in-window rows (distinct signal instants
 *    for limit signals) across USAGE_READINGS_MIN_DAYS distinct UTC
 *    days. The corruption item needs no recurrence bar — the writer's
 *    refusal is present-tense.
 *  - Only contract-valid rows feed the per-pool axes; rows that fail
 *    the writer's own checkedReading shape are corruption evidence,
 *    never folded as readings. pctUsed null is the writer's own
 *    "probe ran, meter unread" status, not missing data.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's usage pools and carries no repository column. Dedup is
 *    downstream: the item id hashes the cell identity, never counts
 *    or timestamps, so a refresh re-derives the same id and a
 *    recovered pool simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { USAGE_EVENTS, USAGE_POOLS, type UsageEvent } from '../fabric/usage-signal-writer.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is pools × axes plus the corruption item. */
export const USAGE_READINGS_BACKLOG_MAX_ITEMS = 12;
const USAGE_READINGS_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const USAGE_READINGS_WINDOW_HOURS = 168;
/** A per-pool or per-event cell emits only at this many in-window rows (distinct instants for limit signals)... */
export const USAGE_READINGS_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days. */
export const USAGE_READINGS_MIN_DAYS = 2;
/** Bounded no-follow tail; the writer caps the file at 8 MiB and never compacts. */
export const USAGE_READINGS_TAIL_BYTES = 1024 * 1024;
/** The fleet's own repository label: usage-signal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded pool names are bounded identifiers; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** The writer's pseudo-pool carried on codex-cmp rows; the strict contract admits it alongside USAGE_POOLS. */
const EXTRA_POOL = 'codex-cmp';
/** The two closed event kinds that mark a provider limit signal. */
const LIMIT_EVENTS = new Set<string>(['429', 'limit-message']);

export interface UsageReadingsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: join(runsDir, 'queue', 'usage-readings.log')). */
  journalPath?: string;
  /** Runs dir for the journal default; a non-empty absolute ASHLR_RUNS_DIR wins, else ~/.ashlr-runs — the CLI's own resolution. */
  runsDir?: string;
  /** Home for the ~/.ashlr-runs fallback; default homedir(). */
  homeDir?: string;
  /** Evidence window in hours (default USAGE_READINGS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default USAGE_READINGS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** The runs dir the CLI's own resolution picks: absolute ASHLR_RUNS_DIR, else ~/.ashlr-runs. */
function defaultRunsDir(homeDir: string): string {
  const env = process.env['ASHLR_RUNS_DIR'];
  if (env !== undefined && env !== '' && isAbsolute(env)) return env;
  return join(homeDir, '.ashlr-runs');
}

// ---------------------------------------------------------------------------
// Row contract — one UsageReading exactly as writeUsageSignal appends it
// ---------------------------------------------------------------------------

const KNOWN_POOLS = new Set<string>([...USAGE_POOLS, EXTRA_POOL]);
const KNOWN_EVENTS = new Set<string>(USAGE_EVENTS);
const ROW_KEYS = new Set([
  'pool', 'pctUsed', 'resetAt', 'source', 'fetchedAt', 'writtenAt', 'event',
  'burnRatePctPerHour', 'projected100At', 'cutActive',
]);

/** The writer's own timestamp rule: canonical 24-char ISO that round-trips. */
function isContractTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isContractPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** source() in the writer: grok-ultra reads through 'grok-reader', every other pool through '<pool>-reader'. */
function contractSource(pool: string): string {
  return pool === 'grok-ultra' ? 'grok-reader' : `${pool}-reader`;
}

interface SignalRow {
  pool: string;
  event: UsageEvent;
  pctUsed: number | null;
  resetAtMs: number | null;
  writtenAtMs: number;
}

/**
 * Structural validation of one persisted row against the writer's
 * checkedReading contract, mirrored key-for-key: closed pool and event
 * vocabularies, pctUsed null or a finite percentage in [0, 100], resetAt
 * and projected100At null or canonical timestamps, fetchedAt/writtenAt
 * canonical timestamps, source exactly the writer's per-pool label,
 * burnRatePctPerHour null or a finite non-negative number, cutActive a
 * boolean, and no keys outside the contract. Returns the projected row
 * or null — a corrupted or foreign row is corruption evidence, never a
 * reading.
 */
function projectRow(row: Record<string, unknown>): SignalRow | null {
  const pool = row['pool'];
  const event = row['event'];
  if (typeof pool !== 'string' || !KNOWN_POOLS.has(pool)) return null;
  if (typeof event !== 'string' || !KNOWN_EVENTS.has(event)) return null;
  const pctUsed = row['pctUsed'];
  if (pctUsed !== null && !isContractPercent(pctUsed)) return null;
  const resetAt = row['resetAt'];
  if (resetAt !== null && !isContractTimestamp(resetAt)) return null;
  if (!isContractTimestamp(row['fetchedAt']) || !isContractTimestamp(row['writtenAt'])) return null;
  if (row['source'] !== contractSource(pool)) return null;
  if (typeof row['cutActive'] !== 'boolean') return null;
  const burn = row['burnRatePctPerHour'];
  if (burn !== null && (typeof burn !== 'number' || !Number.isFinite(burn) || burn < 0)) return null;
  const projected = row['projected100At'];
  if (projected !== null && !isContractTimestamp(projected)) return null;
  if (!Object.keys(row).every((key) => ROW_KEYS.has(key))) return null;
  return {
    pool,
    event: event as UsageEvent,
    pctUsed: pctUsed as number | null,
    resetAtMs: resetAt === null ? null : Date.parse(resetAt as string),
    writtenAtMs: Date.parse(row['writtenAt'] as string),
  };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-pool in-window probe-miss fold before the recurring bars apply. */
interface ProbeCell {
  rows: number;
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

/** Per-event-kind in-window limit-signal fold: one signal writes one row per selected pool at the same writtenAt. */
interface LimitCell {
  /** Distinct signal instants — distinct writtenAt values across the event's rows. */
  instants: Set<number>;
  days: Set<string>;
  pools: Set<string>;
  rows: number;
  firstMs: number | null;
  lastMs: number | null;
}

/** Per-pool in-window meter-regression fold: same-reset-window used-percent decreases. */
interface RegressionCell {
  steps: number;
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  /** Largest single-window drop observed, in percentage points. */
  worstDrop: number;
}

export interface UsageReadingsFold {
  /** Contract-valid rows seen in the scanned text. */
  rows: number;
  /** Lines that failed the writer's append-time validation, by kind. */
  corrupt: { unparsable: number; invalid: number; regression: number };
  /** Pool labels extractable from invalid rows, for prompt evidence. */
  invalidPools: Map<string, number>;
  probeMisses: Map<string, ProbeCell>;
  limitSignals: Map<string, LimitCell>;
  regressions: Map<string, RegressionCell>;
  /** Parsed rows outside the window or beyond the future-skew tolerance. */
  outsideWindow: number;
}

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

/**
 * Pure: fold journal text(s) — oldest first — into corruption,
 * probe-miss, limit-signal and meter-regression evidence. Lines that
 * fail the writer's row contract are corruption, never readings; the
 * writer's own per-pool writtenAt monotonicity is checked across the
 * whole scanned text because journal() validates the whole file on
 * every append.
 */
export function foldUsageReadings(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): UsageReadingsFold {
  const fold: UsageReadingsFold = {
    rows: 0,
    corrupt: { unparsable: 0, invalid: 0, regression: 0 },
    invalidPools: new Map(),
    probeMisses: new Map(),
    limitSignals: new Map(),
    regressions: new Map(),
    outsideWindow: 0,
  };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  /** Per-pool last writtenAt string — the writer's monotonicity check, mirrored. */
  const lastWrittenAt = new Map<string, string>();
  /** In-window contract rows per pool, for the meter-regression pass. */
  const poolRows = new Map<string, SignalRow[]>();

  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fold.corrupt.unparsable++;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fold.corrupt.invalid++;
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const row = projectRow(record);
      if (row === null) {
        fold.corrupt.invalid++;
        const maybePool = record['pool'];
        if (typeof maybePool === 'string' && KNOWN_POOLS.has(maybePool)) {
          fold.invalidPools.set(maybePool, (fold.invalidPools.get(maybePool) ?? 0) + 1);
        }
        continue;
      }
      fold.rows++;
      // journal() enforces per-pool writtenAt monotonicity over every
      // non-codex-cmp row, in file order; a regression throws on append.
      if (row.pool !== EXTRA_POOL) {
        const last = lastWrittenAt.get(row.pool);
        const writtenAtRaw = record['writtenAt'] as string;
        if (last !== undefined && writtenAtRaw < last) fold.corrupt.regression++;
        else lastWrittenAt.set(row.pool, writtenAtRaw);
      }
      if (row.writtenAtMs < since || row.writtenAtMs > until) { fold.outsideWindow++; continue; }

      if (row.pctUsed === null) {
        let cell = fold.probeMisses.get(row.pool);
        if (cell === undefined) {
          cell = { rows: 0, days: new Set(), firstMs: null, lastMs: null };
          fold.probeMisses.set(row.pool, cell);
        }
        cell.rows += 1;
        cell.days.add(dayOf(row.writtenAtMs));
        touch(cell, row.writtenAtMs);
      }
      if (LIMIT_EVENTS.has(row.event)) {
        let cell = fold.limitSignals.get(row.event);
        if (cell === undefined) {
          cell = { instants: new Set(), days: new Set(), pools: new Set(), rows: 0, firstMs: null, lastMs: null };
          fold.limitSignals.set(row.event, cell);
        }
        cell.instants.add(row.writtenAtMs);
        cell.days.add(dayOf(row.writtenAtMs));
        cell.pools.add(row.pool);
        cell.rows += 1;
        touch(cell, row.writtenAtMs);
      }
      let list = poolRows.get(row.pool);
      if (list === undefined) { list = []; poolRows.set(row.pool, list); }
      list.push(row);
    }
  }

  // Meter regression: inside one unchanged reset window, used-percent
  // must never decrease — the writer's own burn-rate math requires
  // non-decreasing readings. A decrease means the reader returned
  // stale or inconsistent data. Compare consecutive readings in
  // writtenAt order per pool.
  for (const [pool, rows] of poolRows) {
    rows.sort((a, b) => a.writtenAtMs - b.writtenAtMs);
    let cell: RegressionCell | null = null;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      if (prev.pctUsed === null || cur.pctUsed === null) continue;
      if (prev.resetAtMs === null || cur.resetAtMs === null || prev.resetAtMs !== cur.resetAtMs) continue;
      if (cur.pctUsed >= prev.pctUsed) continue;
      if (cell === null) {
        cell = { steps: 0, days: new Set(), firstMs: null, lastMs: null, worstDrop: 0 };
        fold.regressions.set(pool, cell);
      }
      cell.steps += 1;
      cell.days.add(dayOf(cur.writtenAtMs));
      cell.worstDrop = Math.max(cell.worstDrop, prev.pctUsed - cur.pctUsed);
      touch(cell, cur.writtenAtMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface UsageReadingsCell {
  kind: 'usage-readings';
  /** 'corrupt' | 'limit' | 'probe' | 'regress'. */
  axis: string;
  /** Event kind for limit cells, pool label otherwise ('journal' for corrupt). */
  key: string;
  rows: number;
  /** Distinct UTC days (limit cells: days carrying the signal; corrupt: 0). */
  days: string[];
  /** Contract-valid rows in the scanned text — the share denominator. */
  totalRows: number;
  /** Corruption counts by kind (corrupt cells only). */
  corrupt: { unparsable: number; invalid: number; regression: number } | null;
  /** Pools extractable from invalid rows (corrupt cells only). */
  invalidPools: string[];
  /** Distinct signal instants (limit cells only). */
  instants: number;
  /** Pools that carried the evidence (limit cells only). */
  pools: string[];
  /** Largest single-window meter drop, percentage points (regress cells only). */
  worstDrop: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

function cellBase(fold: UsageReadingsFold): Omit<UsageReadingsCell, 'kind' | 'axis' | 'key'> {
  return {
    rows: 0, days: [], totalRows: fold.rows, corrupt: null, invalidPools: [],
    instants: 0, pools: [], worstDrop: null, firstSeen: null, lastSeen: null, lowerBound: false,
  };
}

/**
 * Pure: the cells one fold emits — the corruption item at any scanned
 * violation (the writer's refusal is present-tense), then recurring
 * limit-signal, probe-miss and meter-regression cells at the row/day
 * bars. Emission order puts the broken writer first, then provider
 * pressure, then degraded evidence, then inconsistency.
 */
export function usageReadingsCells(fold: UsageReadingsFold, lowerBound = false): UsageReadingsCell[] {
  const cells: UsageReadingsCell[] = [];
  const corruptTotal = fold.corrupt.unparsable + fold.corrupt.invalid + fold.corrupt.regression;
  if (corruptTotal > 0) {
    cells.push({
      ...cellBase(fold),
      kind: 'usage-readings', axis: 'corrupt', key: 'journal',
      rows: corruptTotal,
      corrupt: { ...fold.corrupt },
      invalidPools: [...fold.invalidPools.keys()].sort(),
      lowerBound,
    });
  }
  for (const event of ['429', 'limit-message'] as const) {
    const cell = fold.limitSignals.get(event);
    if (cell === undefined) continue;
    if (cell.instants.size < USAGE_READINGS_MIN_ROWS || cell.days.size < USAGE_READINGS_MIN_DAYS) continue;
    cells.push({
      ...cellBase(fold),
      kind: 'usage-readings', axis: 'limit', key: event,
      rows: cell.rows,
      days: [...cell.days].sort(),
      instants: cell.instants.size,
      pools: [...cell.pools].sort(),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  const probeCells = [...fold.probeMisses.entries()]
    .filter(([, cell]) => cell.rows >= USAGE_READINGS_MIN_ROWS && cell.days.size >= USAGE_READINGS_MIN_DAYS)
    .sort((a, b) => b[1].rows - a[1].rows || a[0].localeCompare(b[0]));
  for (const [pool, cell] of probeCells) {
    cells.push({
      ...cellBase(fold),
      kind: 'usage-readings', axis: 'probe', key: pool,
      rows: cell.rows,
      days: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  const regressCells = [...fold.regressions.entries()]
    .filter(([, cell]) => cell.steps >= USAGE_READINGS_MIN_ROWS && cell.days.size >= USAGE_READINGS_MIN_DAYS)
    .sort((a, b) => b[1].steps - a[1].steps || a[0].localeCompare(b[0]));
  for (const [pool, cell] of regressCells) {
    cells.push({
      ...cellBase(fold),
      kind: 'usage-readings', axis: 'regress', key: pool,
      rows: cell.steps,
      days: [...cell.days].sort(),
      worstDrop: cell.worstDrop,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/queue/usage-readings.log — the usage store directory `phm usage signal --directory` targets in production — one {pool, pctUsed, resetAt, source, fetchedAt, writtenAt, event, burnRatePctPerHour, projected100At, cutActive} UsageReading row per pool per signal pass, appended by writeUsageSignal (src/core/fabric/usage-signal-writer.ts) and triggered by the closed event vocabulary dispatch-start, pr-merge, 429, limit-message, manual-reading and hourly. Until now the journal\'s only readers were display and point-in-time surfaces — the lane-console and mission-control projections, the reward-feed and growth series readers, and `phm fleet usage-audit` (src/core/fleet/usage-motion-audit.ts), a report someone had to run — so a journal the strict writer refuses to append to, a pool whose meter stayed unread, a fleet whose providers kept answering limit signals, or a meter that kept reporting less used-percent inside one reset window never became work.';

const REPRO = 'Reproduce the fold by reading <runs dir>/queue/usage-readings.log directly: a line that fails JSON.parse, the writer\'s checkedReading contract (closed pool/event vocabularies, canonical timestamps, the per-pool source label, exactly the ten contract keys), or the per-pool writtenAt monotonicity journal() enforces is corruption the writer throws on; contract-valid rows inside the window then group by pool for pctUsed-null probe misses and same-reset-window used-percent decreases, and by event for distinct 429/limit-message signal instants. The writer, row builder and reader dispatch this repository owns are src/core/fabric/usage-signal-writer.ts and src/core/fabric/usage-signal-readers.ts; the audit that interprets the same file on demand is src/core/fleet/usage-motion-audit.ts.';

const NO_CHANGE = 'If `phm usage signal` only runs on demand the journal is a sparse sample rather than a continuous record; if the pool\'s plan cap or provider plan is the binding constraint, resizing is owner-only; if the meter legitimately reads lower after a provider-side adjustment the resetAt boundary should have moved — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: UsageReadingsCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: UsageReadingsCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: UsageReadingsCell): string =>
  cell.totalRows > 0 ? ` (${Math.round((cell.rows / cell.totalRows) * 100)}% of the ${cell.totalRows} contract-valid in-window rows)` : '';

function usageReadingsPrompt(cell: UsageReadingsCell): string {
  const detail: string[] = [];
  if (cell.axis === 'corrupt') {
    const c = cell.corrupt;
    const parts = [
      c && c.unparsable > 0 ? `${c.unparsable} unparsable line(s)` : '',
      c && c.invalid > 0 ? `${c.invalid} row(s) failing the writer's checkedReading contract${cell.invalidPools.length > 0 ? ` (pools named: ${cell.invalidPools.join(', ')})` : ''}` : '',
      c && c.regression > 0 ? `${c.regression} per-pool writtenAt regression(s)` : '',
    ].filter(Boolean).join('; ');
    detail.push(
      `Phantom's usage-signal journal is failing its own append contract`,
      '',
      `${parts} inside the retained tail — and writeUsageSignal's journal() validates EVERY line of the whole file on every append, throwing 'Usage journal is invalid' or 'Usage journal moved backwards', so every \`phm usage signal\` pass now fails until the file is repaired.${boundText(cell)}`,
      '',
      EVIDENCE,
      '',
      `Find what wrote the violating bytes: the only sanctioned appender is writeUsageSignal itself (rows are built field-by-field by reading() and always satisfy checkedReading), so corruption means a torn append, a foreign writer, or a manual edit — check the file's mtime against the last signal pass, then decide where the repair lives: a bounded quarantine/repair path in src/core (the file is mode-0600 private ops data under the usage store, so the repo-owned fix is tooling or a tolerant-then-repair writer mode, never silent truncation of evidence), plus whatever produced the bad bytes. The audit's tolerant parser (parseMotionJournal in src/core/fleet/usage-motion-audit.ts) keeps classifying lanes off the same file — reconcile the two readers' contract drift while here.`,
      '',
      NO_CHANGE,
      '',
      REPRO,
    );
    return detail.join('\n');
  }
  if (cell.axis === 'limit') {
    const eventLabel = cell.key === '429' ? 'HTTP 429 rate-limit' : 'provider limit-message';
    detail.push(
      `Phantom's usage-signal journal keeps recording ${eventLabel} passes`,
      '',
      `${cell.instants} distinct signal instant(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) — each one a \`phm usage signal --event ${cell.key}\` pass some caller fired after observing ${cell.key === '429' ? 'a provider rate-limit response' : 'a provider limit message'}; the pools measured at those instants were ${cell.pools.join(', ')}.${seenText(cell)}${boundText(cell)}`,
      '',
      `Each instant is one limit signal the fleet observed and answered with a usage pass — recurring signals mean the providers keep throttling or warning the fleet.${shareText(cell)}`,
      '',
      EVIDENCE,
      '',
      `Find why ${cell.key === '429' ? 'providers keep answering 429' : 'providers keep emitting limit messages'}: check which caller fires \`phm usage signal --event ${cell.key}\` (search src/ and contrib/mac for the event spelling), whether dispatch cadence or parallel lanes exceed the provider ceilings the router's capacity snapshot (~/.ashlr/routing/capacity.json) believes in, whether the router keeps scheduling onto a throttled seat instead of rotating (src/core/routing), and whether the signal itself is a false positive from an unrelated caller — the journal does not attribute the limit to a pool, so establish attribution before fixing routing. Fix what lives here — the caller that mis-fires the event, the dispatch cadence, or the capacity evidence feeding routing.`,
      '',
      NO_CHANGE,
      '',
      REPRO,
    );
    return detail.join('\n');
  }
  if (cell.axis === 'probe') {
    const pool = fieldText(cell.key, MAX_NAME_CHARS);
    detail.push(
      `Phantom's usage pool '${pool}' keeps reporting unreadable meters`,
      '',
      `${cell.rows} probe-miss row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) for '${pool}' — passes where the reader ran but pctUsed stayed null, the writer's own "probe ran, meter unread" status.${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
      '',
      EVIDENCE,
      '',
      `Find why '${pool}'s reader keeps missing the meter: check the reader command this pool is configured with (the --readers JSON under the ops configuration, resolved by usageReaderCommands in src/core/fabric/usage-signal-readers.ts) and the builtin status readers in src/core/fabric/status-readings.ts — whether the provider changed the page or API shape the command scrapes, whether the reader's debounce window (USAGE_DEBOUNCE_MS, 30 minutes in the writer) is discarding fresher readings, whether the command is failing silently (writeUsageSignal swallows reader errors into null pctUsed by design), or whether the pool's plan genuinely exposes no meter. Fix what lives here — the reader command contract, the parsing in usage-signal-readers.ts/status-readings.ts, or the evidence path that should mark the pool's readings stale instead of null.`,
      '',
      NO_CHANGE,
      '',
      REPRO,
    );
    return detail.join('\n');
  }
  const pool = fieldText(cell.key, MAX_NAME_CHARS);
  const drop = cell.worstDrop === null ? '' : ` Largest single-window drop ${Math.round(cell.worstDrop * 10) / 10} points.`;
  detail.push(
    `Phantom's usage pool '${pool}' keeps reporting less used-percent inside one reset window`,
    '',
    `${cell.rows} same-reset-window decrease(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) for '${pool}' — consecutive contract-valid readings where pctUsed fell while resetAt stayed identical, which the writer's own burn-rate math treats as impossible.${drop}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why '${pool}'s meter goes backwards inside one allowance window: the writer only computes burnRatePctPerHour when pctUsed is non-decreasing, so each decrease silently voids that interval's burn evidence — check whether the configured reader returns cached or stale meter values (usage-signal-readers.ts command output vs the provider's live page), whether two readers race the same pool, whether the provider resets its counter without moving resetAt (a contract violation the reader should surface), or whether writtenAt ordering hides an out-of-order append. Fix what lives here — reader freshness guarantees, the parsing contract, or the resetAt semantics the readers report.`,
    '',
    NO_CHANGE,
    '',
    REPRO,
  );
  return detail.join('\n');
}

function usageReadingsTitle(cell: UsageReadingsCell): string {
  switch (cell.axis) {
    case 'corrupt': return `Usage-signal journal is failing its append contract`.slice(0, MAX_TITLE_CHARS);
    case 'limit': return `Usage signals keep recording provider ${cell.key} passes`.slice(0, MAX_TITLE_CHARS);
    case 'probe': return `Usage pool '${fieldText(cell.key, MAX_NAME_CHARS)}' keeps unreadable meters`.slice(0, MAX_TITLE_CHARS);
    case 'regress': return `Usage pool '${fieldText(cell.key, MAX_NAME_CHARS)}' meter keeps going backwards`.slice(0, MAX_TITLE_CHARS);
    default: return `Usage-signal journal recurring evidence`.slice(0, MAX_TITLE_CHARS);
  }
}

function usageReadingsArea(cell: UsageReadingsCell): string {
  switch (cell.axis) {
    case 'corrupt': return 'usage-journal-corrupt';
    case 'limit': return 'usage-limit-signal';
    case 'probe': return 'usage-meter-probe';
    case 'regress': return 'usage-meter-regression';
    default: return 'usage-readings';
  }
}

function usageReadingsItem(cell: UsageReadingsCell, repo: string): CloudBacklogItem {
  return {
    id: `usage-readings-${sha(`${cell.axis}|${cell.key}`)}`,
    title: usageReadingsTitle(cell),
    prompt: usageReadingsPrompt(cell),
    area: usageReadingsArea(cell),
    priority: cell.axis === 'corrupt' ? 2 : 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the usage-signal journal's recurring evidence.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function usageReadingsBacklogItems(opts: UsageReadingsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? USAGE_READINGS_WINDOW_HOURS;
    const homeDir = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? defaultRunsDir(homeDir);
    const journalPath = opts.journalPath ?? join(runsDir, 'queue', 'usage-readings.log');
    const read = await readLedgerTail(journalPath, USAGE_READINGS_TAIL_BYTES);
    if (read.state !== 'read') return [];
    // readLedgerTail has no time filter; the fold's per-row window check
    // drops everything older than the window, so the tail folds whole —
    // while the corruption check still sees every scanned line, matching
    // the writer's whole-file validation.
    const fold = foldUsageReadings([read.text], nowMs, windowHours);
    const cells = usageReadingsCells(fold, read.truncated);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? USAGE_READINGS_BACKLOG_MAX_ITEMS, USAGE_READINGS_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => usageReadingsItem(cell, repo));
  } catch {
    return [];
  }
}
