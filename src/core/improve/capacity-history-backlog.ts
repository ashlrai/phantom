/**
 * Seat capacity-history journal recurring evidence → self-improvement backlog items.
 *
 * Phantom records each paid seat's window usage as a rolling log beside
 * the latest-only snapshot: ~/.ashlr/routing/capacity.json holds the
 * current readings while ~/.ashlr/routing/capacity-history.jsonl
 * (CAPACITY_HISTORY_FILE, src/core/routing/capacity-history.ts) holds
 * one {ts, seat, window, usedPct, resetsAt?, source} row per seat
 * window per recorded sample. Two recorders append through
 * appendCapacityHistory/appendCapacitySamples — the daemon's capacity
 * publisher on every publish and check, and the Verse server after
 * each budget read the UI polls plus a 60 s follow — so history keeps
 * growing while the fleet is dark. Rows carry the seat's observedAt,
 * flat runs compress to one row per change or per 10 minutes, rows
 * older than the eight-day keep horizon are dropped and the file is
 * atomically rewritten past 2 MiB, and both recorders share one
 * last-row tail read so a second recorder is a no-op rather than a
 * duplicate.
 *
 * Until now the file's only reader was GET /api/verse/budget/history
 * (capacity-history-api.ts → buildCapacityHistoryResponse → the
 * Command burn-down charts, a surface someone had to open), so seat
 * window series that kept missing whole recorded UTC days, a
 * recorder that kept going quiet, contract-failing lines the store's
 * readers silently skip and a series count past the response's
 * 32-series truncation bound never became work.
 * capacityHistoryBacklogItems carries the same journal into
 * discoverBacklog:
 *
 *  - 'series-dark' cells recurring per seat-window series: file-
 *    active UTC days (days the retained tail holds at least one
 *    valid row — the recorders were alive) after the series' first
 *    row inside the store's own eight-day keep window on which the
 *    series itself recorded nothing. A series whose seat left the
 *    snapshot or whose window reclassified ends the same way, so the
 *    prompt sends the agent to the live capacity snapshot before
 *    calling it a gap.
 *  - 'recorder-stale': the newest valid row is over a day old — both
 *    recorders quiet (or ASHLR_CAPACITY_HISTORY=0, an unreadable
 *    routing dir, a dead Verse follow) while the file still sits
 *    there.
 *  - 'corrupt-lines': three or more lines inside the retained tail
 *    fail the store's own parseHistoryLine contract — torn writes,
 *    foreign lines or shape drift the store's readers skip without
 *    a trace.
 *  - 'series-overflow': more distinct seat-window series recorded in
 *    the keep window than HISTORY_MAX_SERIES — the response slices
 *    the sorted keys and marks `truncated`, so the overflowed series
 *    never render on Command at all.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail at the store's own 4 MiB read bound; nothing is
 *    written and no network is touched. Missing, non-file or
 *    unreadable evidence yields no items.
 *  - The journal describes this install's seats and carries no
 *    repository column, so like the sibling fleet-evidence feeds,
 *    items emit only when the backlog's repo name is the fleet's
 *    own; another repository inherits nothing.
 *  - Rows count only under the writer's contract: the store's own
 *    parseHistoryLine (ISO ts, seat inside BUDGET_SEAT_ID_RE, window
 *    'session'|'weekly', usedPct 0–100, optional ISO resetsAt,
 *    source 'daemon'|'verse'). Malformed lines and off-contract rows
 *    are skipped, never guessed; a truncated tail still folds the
 *    retained rows with the prompts stating the counts as lower
 *    bounds.
 *  - The analysis window is the store's own keep horizon
 *    (HISTORY_KEEP_MS, eight days) plus the sibling feeds' one-minute
 *    future-skew tolerance: rows outside it contribute nothing, so a
 *    stale pre-compaction row cannot fake a dark day and a
 *    future-stamped row cannot fake activity.
 *  - 'series-dark' emits only at the recurring bar of two missed
 *    file-active UTC days after the series' first in-window row — a
 *    series one day behind proves nothing. 'recorder-stale' fires
 *    only when at least one valid row exists (an empty or
 *    all-corrupt file leaves staleness unknown, covered by
 *    'corrupt-lines' instead). 'corrupt-lines' needs three contract
 *    failures so one torn tail fragment never emits.
 *  - Dedup is downstream. Item ids hash the cell kind + series key +
 *    repo (never the counts or timestamps), so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    series that resumes recording simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, series names come from validated rows,
 *    and the brief names the journal, both recorders, the store
 *    contract and the burn-down reader with the usual no-change
 *    escape when the window no longer reproduces or the seat
 *    legitimately left the fleet.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  CAPACITY_HISTORY_FILE,
  HISTORY_KEEP_MS,
  HISTORY_MAX_SERIES,
  historySeriesKey,
  parseHistoryLine,
} from '../routing/capacity-history.js';
import type { CapacityHistoryWindow } from '../routing/capacity-history-types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the series set is bounded by the seat cap. */
export const CAPACITY_HISTORY_MAX_ITEMS = 8;
const CAPACITY_HISTORY_ITEM_HARD_MAX = 25;
/**
 * Future-skew ceiling on journal `ts` stamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift: a row stamped
 * further ahead than the evaluation time is corrupt or replayed
 * evidence and never reaches a cell.
 */
export const CAPACITY_HISTORY_FUTURE_SKEW_MS = 60_000;
/** A recorder this quiet is stale: both writers check far more often. */
export const CAPACITY_HISTORY_STALE_MS = 24 * 60 * 60 * 1000;
/** Contract-failing lines one cell needs inside the retained tail. */
export const CAPACITY_HISTORY_CORRUPT_MIN = 3;
/** Missed file-active UTC days one dark series needs inside the window. */
export const CAPACITY_HISTORY_DARK_MIN_DAYS = 2;
/**
 * Bounded tail for the journal, the store's own MAX_READ_BYTES: the
 * file compacts at 2 MiB and readers never load past 4 MiB, so this
 * bound sees everything the store itself would.
 */
export const CAPACITY_HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: capacity evidence is this install's seats. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

export interface CapacityHistoryItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: <home>/.ashlr/routing/capacity-history.jsonl). */
  journalPath?: string;
  /** Home for the default journal dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default CAPACITY_HISTORY_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated history row inside the analysis window. */
export interface CapacityHistoryFoldRow {
  tsMs: number;
  utcDay: string;
  seat: string;
  window: CapacityHistoryWindow;
  seriesKey: string;
}

/** The journal parse result: in-window rows plus the contract-failure count. */
export interface CapacityHistoryParse {
  rows: CapacityHistoryFoldRow[];
  /** Non-blank lines parseHistoryLine rejected inside the retained tail. */
  corrupt: number;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse journal text into validated rows plus a contract-failure
 * count. Every non-blank line goes through the store's own
 * parseHistoryLine — the same contract its readers apply — so a line
 * that counts as evidence here is exactly a line the store would
 * serve. Rows outside the keep window or past the future skew parse
 * fine but fold nowhere; they are neither evidence nor corruption.
 */
export function parseCapacityHistoryJournal(
  text: string,
  nowMs: number,
): CapacityHistoryParse {
  const rows: CapacityHistoryFoldRow[] = [];
  let corrupt = 0;
  const windowStart = nowMs - HISTORY_KEEP_MS;
  const until = nowMs + CAPACITY_HISTORY_FUTURE_SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parsed = parseHistoryLine(trimmed);
    if (parsed === null) {
      corrupt += 1;
      continue;
    }
    const tsMs = Date.parse(parsed.ts);
    if (!Number.isFinite(tsMs)) {
      corrupt += 1;
      continue;
    }
    if (tsMs < windowStart || tsMs > until) continue;
    rows.push({
      tsMs,
      utcDay: utcDayOf(tsMs),
      seat: parsed.seat,
      window: parsed.window,
      seriesKey: historySeriesKey(parsed.seat, parsed.window),
    });
  }
  return { rows, corrupt };
}

/** One seat-window series' in-window evidence. */
export interface CapacitySeriesFold {
  seriesKey: string;
  seat: string;
  window: CapacityHistoryWindow;
  /** UTC days the series itself recorded inside the window. */
  days: Set<string>;
  /** UTC day of the series' first in-window row. */
  firstDay: string;
  /** Newest row instant inside the window. */
  lastMs: number;
  /** File-active UTC days the series missed after firstDay. */
  missedDays: number;
}

/** The fold's output. */
export interface CapacityHistoryFold {
  /** UTC days holding at least one valid in-window row (recorder alive). */
  fileActiveDays: Set<string>;
  /** Distinct in-window series by historySeriesKey. */
  series: Map<string, CapacitySeriesFold>;
  /** Newest valid in-window row instant, or null when none parsed. */
  newestMs: number | null;
  /** Contract-failing lines inside the retained tail. */
  corrupt: number;
}

/**
 * Pure: fold parsed rows into per-series evidence. A day is
 * file-active when any valid in-window row lands on it; a series is
 * dark on a file-active day at-or-after its first in-window row day
 * when it recorded nothing that day. Missed days count through the
 * newest file-active day — a series that stopped while the recorder
 * kept writing accrues them whether it ended by seat removal or by a
 * recording gap, and the prompt sorts the two apart.
 */
export function foldCapacityHistoryRows(
  rows: readonly CapacityHistoryFoldRow[],
  corrupt: number,
): CapacityHistoryFold {
  const fileActiveDays = new Set<string>();
  const series = new Map<string, CapacitySeriesFold>();
  let newestMs: number | null = null;
  for (const row of rows) {
    fileActiveDays.add(row.utcDay);
    if (newestMs === null || row.tsMs > newestMs) newestMs = row.tsMs;
    let cell = series.get(row.seriesKey);
    if (cell === undefined) {
      cell = {
        seriesKey: row.seriesKey,
        seat: row.seat,
        window: row.window,
        days: new Set(),
        firstDay: row.utcDay,
        lastMs: row.tsMs,
        missedDays: 0,
      };
      series.set(row.seriesKey, cell);
    }
    cell.days.add(row.utcDay);
    if (row.utcDay < cell.firstDay) cell.firstDay = row.utcDay;
    if (row.tsMs > cell.lastMs) cell.lastMs = row.tsMs;
  }
  const activeDays = [...fileActiveDays].sort();
  for (const cell of series.values()) {
    let missed = 0;
    for (const day of activeDays) {
      if (day < cell.firstDay) continue;
      if (!cell.days.has(day)) missed += 1;
    }
    cell.missedDays = missed;
  }
  return { fileActiveDays, series, newestMs, corrupt };
}

const KEEP_DAYS = Math.round(HISTORY_KEEP_MS / 86_400_000);

const NO_CHANGE = 'If the window has rolled forward, the series resumed recording, the seat legitimately left the snapshot or its window reclassified, both recorders verified healthy on a fresh read, or the right fix is owner-only (provider credentials, billing, a protected gate) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is routing/capacity-history.jsonl under the Phantom home (~/.ashlr/routing/capacity-history.jsonl, CAPACITY_HISTORY_FILE in src/core/routing/capacity-history.ts): appendCapacityHistory and appendCapacitySamples append one {ts, seat, window, usedPct, resetsAt?, source} row per seat window per recorded sample — written by the daemon\'s capacity publisher on every publish and check (daemon/capacity-publisher.ts) and by the Verse server after each budget read the UI polls plus its 60 s follow (capacity-history-api.ts), with flat-run compression (a row on change or per 10 minutes), an eight-day keep horizon and atomic compaction past 2 MiB. Its only reader until this feed was GET /api/verse/budget/history — buildCapacityHistoryResponse grouping rows into at most HISTORY_MAX_SERIES (32) series of HISTORY_MAX_POINTS_PER_SERIES (720) points for the Command burn-down charts — a surface someone had to open.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

function darkPrompt(cell: CapacitySeriesFold, fold: CapacityHistoryFold, truncated: boolean): string {
  const missedList = [...fold.fileActiveDays].sort()
    .filter((d) => d >= cell.firstDay && !cell.days.has(d))
    .join(', ');
  return [
    `Phantom's seat capacity history keeps recording nothing for '${cell.seat}' '${cell.window}' on days the recorder was alive — the series went dark while sibling seat windows kept recording.`,
    '',
    `Inside the store's ${KEEP_DAYS}-day keep window the series '${cell.seriesKey}' recorded on ${cell.days.size} distinct UTC day(s), first ${cell.firstDay}, last row ${new Date(cell.lastMs).toISOString()}; ${cell.missedDays} file-active UTC day(s) passed after its first row with no row of its own (${missedList}).${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `A dark series means one of two things. Either the seat legitimately stopped being recorded — it left the capacity snapshot (seat retired, provider dropped, budget policy changed) or its window reclassified to the other class (historyWindowClass in src/core/routing/capacity-history.ts decides session vs weekly per reset period) — in which case the new series should appear under the same seat id and there is nothing to fix. Or the recorder kept running for every other series while this one got no rows — a per-seat recording gap: a window whose readings stopped parsing into historyRowsFromSeats/historyRowsFromSamples, a seat id that fell out of BUDGET_SEAT_ID_RE, or a snapshot shape the store silently skips. Check the live snapshot (~/.ashlr/routing/capacity.json) for whether '${cell.seat}' still reports a '${cell.window}' window, then the recorders' publish path for why this series stopped appending. If the seat legitimately ended and the fold is expected — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function stalePrompt(fold: CapacityHistoryFold, truncated: boolean): string {
  const newest = fold.newestMs === null ? 'none' : new Date(fold.newestMs).toISOString();
  return [
    `Phantom's seat capacity-history recorder has gone quiet — the newest valid row in the retained tail is over a day old while the file still sits in place.`,
    '',
    `The retained tail holds ${fold.series.size} distinct series across ${fold.fileActiveDays.size} file-active UTC day(s); the newest valid row is ${newest}, more than ${Math.round(CAPACITY_HISTORY_STALE_MS / 3_600_000)} h before evaluation.${fold.corrupt > 0 ? ` ${fold.corrupt} line(s) failed the row contract.` : ''}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Both recorders append on a far shorter cadence — the daemon's capacity publisher on every publish and check, the Verse server's budget-read follow on a 60 s loop — so a newest row over a day old means both paths stopped writing: the daemon down with no Verse follow armed, ASHLR_CAPACITY_HISTORY=0 set on both, the routing directory unwritable or the file replaced by something appendCapacityHistory refuses (a non-regular file is rejected by its O_NOFOLLOW open), or every publish failing before the history append. Check whether the fleet is actually dark (then this is expected — report no-change), whether the env kill-switch is set intentionally, and whether capacity.json itself is still being published — a fresh snapshot with a stale history isolates the gap to the append path. ${NO_CHANGE}`,
  ].join('\n');
}

function corruptPrompt(fold: CapacityHistoryFold, truncated: boolean): string {
  return [
    `Phantom's seat capacity-history journal keeps failing its row contract — ${fold.corrupt} line(s) inside the retained tail are not rows the store's own parseHistoryLine accepts.`,
    '',
    `The store's readers (readCapacityHistory, lastRowsBySeries, compaction) skip every line parseHistoryLine rejects without a trace, so foreign or torn lines accumulate invisibly while valid rows keep folding.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The contract is strict on purpose: ISO ts, a seat id inside BUDGET_SEAT_ID_RE, window 'session' or 'weekly', usedPct a finite 0–100, an optional ISO resetsAt and source 'daemon' or 'verse', all inside 1024 chars. Recurring failures mean either a writer started emitting a drifted shape (a capacity-history.ts change that forgot serializeRow's field set), a second process appending foreign lines to the same path, or repeated mid-line deaths leaving torn fragments the append path then treats as fresh-line starts. Check git log on src/core/routing/capacity-history.ts for a recent serializeRow/parseHistoryLine drift, look for other writers of the path, and confirm the corrupt lines are not simply the tail's torn edge (a truncated read drops the partial first line, so counted failures are whole lines). If the lines verify as expected edge noise — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function overflowPrompt(fold: CapacityHistoryFold, truncated: boolean): string {
  const overflow = fold.series.size - HISTORY_MAX_SERIES;
  return [
    `Phantom's seat capacity history records ${fold.series.size} distinct seat-window series — past the response's ${HISTORY_MAX_SERIES}-series bound, so ${overflow} series never render on Command's burn-downs.`,
    '',
    `buildCapacityHistoryResponse sorts the series keys and serves only the first ${HISTORY_MAX_SERIES}, marking the response truncated; the overflowed series keep recording into the journal but no chart ever shows them.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The series space is seat id × window class ('session'|'weekly'), bounded by MAX_SEATS (64) seats plus the pool ids (devin, codex-local) — ${fold.series.size} distinct series means either the fleet genuinely grew past the bound (128 possible series at two windows each is the design ceiling, so this is near it) or stale series from retired seats and reclassified windows are still accruing rows inside the keep window instead of aging out. Check whether old seat ids still appear in the snapshot's seat list or whether window classes are flapping (a flapping class writes both series alternately), and whether HISTORY_MAX_SERIES still fits the real fleet size — raising the bound is a wire-contract change (capacity-history-types.ts) needing the same review as any API shape change. If the count verifies at-or-under the bound on a fresh read — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

type CellKind = 'series-dark' | 'recorder-stale' | 'corrupt-lines' | 'series-overflow';

interface Candidate {
  kind: CellKind;
  /** Series key for per-series cells, '' for install-wide cells. */
  cell: string;
  /** Sort weight: missed days for dark cells, the count for the rest. */
  weight: number;
  item: CloudBacklogItem;
}

function itemId(kind: CellKind, cell: string, repo: string): string {
  const hash = createHash('sha256')
    .update(`capacity-history:${kind}:${cell}:${repo.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `capacity-history-${kind}-${hash}`;
}

function makeItem(kind: CellKind, cell: string, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, cell, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'capacity-history',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

const KIND_TITLE: Record<Exclude<CellKind, 'series-dark'>, string> = {
  'recorder-stale': 'Seat capacity-history recorder has gone quiet',
  'corrupt-lines': 'Seat capacity-history journal keeps failing its row contract',
  'series-overflow': 'Seat capacity-history series count exceeds the burn-down bound',
};

/**
 * Backlog items for the seat capacity-history journal's recurring
 * dark series, stale recorder, contract-failing lines and series
 * overflow. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function capacityHistoryBacklogItems(
  opts: CapacityHistoryItemsOptions,
): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const home = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath
      ?? join(home, '.ashlr', 'routing', CAPACITY_HISTORY_FILE);
    const tail = await readLedgerTail(journalPath, CAPACITY_HISTORY_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const parsed = parseCapacityHistoryJournal(tail.text, nowMs);
    const fold = foldCapacityHistoryRows(parsed.rows, parsed.corrupt);

    const candidates: Candidate[] = [];
    for (const cell of fold.series.values()) {
      if (cell.missedDays >= CAPACITY_HISTORY_DARK_MIN_DAYS) {
        candidates.push({
          kind: 'series-dark',
          cell: cell.seriesKey,
          weight: cell.missedDays,
          item: makeItem(
            'series-dark',
            cell.seriesKey,
            repo,
            `Seat '${cell.seat}' '${cell.window}' capacity series keeps missing recorded days`,
            darkPrompt(cell, fold, tail.truncated),
          ),
        });
      }
    }
    if (fold.newestMs !== null && nowMs - fold.newestMs > CAPACITY_HISTORY_STALE_MS) {
      candidates.push({
        kind: 'recorder-stale',
        cell: '',
        weight: Number.MAX_SAFE_INTEGER,
        item: makeItem('recorder-stale', '', repo, KIND_TITLE['recorder-stale'], stalePrompt(fold, tail.truncated)),
      });
    }
    if (fold.corrupt >= CAPACITY_HISTORY_CORRUPT_MIN) {
      candidates.push({
        kind: 'corrupt-lines',
        cell: '',
        weight: fold.corrupt,
        item: makeItem('corrupt-lines', '', repo, KIND_TITLE['corrupt-lines'], corruptPrompt(fold, tail.truncated)),
      });
    }
    if (fold.series.size > HISTORY_MAX_SERIES) {
      candidates.push({
        kind: 'series-overflow',
        cell: '',
        weight: fold.series.size,
        item: makeItem('series-overflow', '', repo, KIND_TITLE['series-overflow'], overflowPrompt(fold, tail.truncated)),
      });
    }
    // Strongest recorded evidence first; install-wide staleness outranks
    // per-series darkness since it explains every dark cell at once.
    candidates.sort((a, b) =>
      b.weight - a.weight
      || a.cell.localeCompare(b.cell)
      || a.kind.localeCompare(b.kind));
    const limit = Math.max(1, Math.min(opts.limit ?? CAPACITY_HISTORY_MAX_ITEMS, CAPACITY_HISTORY_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => c.item);
  } catch {
    return [];
  }
}
