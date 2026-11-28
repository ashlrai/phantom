/**
 * Lane capacity audit journal → self-improvement backlog items.
 *
 * Writer contract (<runs>/queue/lane-target-changes.log — the fleet
 * runs directory, ~/.ashlr-runs or $ASHLR_RUNS_DIR):
 *  - setLaneTarget (src/core/fleet/runs-lane-targets.ts) appends one
 *    `<iso>\t<lane>\t<old>-><target>\t<by>` line per committed
 *    concurrency-target change — `phm fleet lane-target`, the desktop
 *    and verse control surfaces, telegram commands and `phm autofix`'s
 *    host-node retune all land here; target 0 is the lane's pause.
 *  - placeLaneHold (src/core/fleet/runs-lane-hold-place.ts) appends
 *    `<iso>\t<lane>\thold <minutes>m\t<by>: <reason>` per committed
 *    hold — minutes bounded 1..1440, reason printable ASCII 1..120 —
 *    placed by `phm fleet lane-hold`, the lane-autohold empty-streak
 *    brake, the incident gate's recurring-class hold, telegram and the
 *    desktop holds surface.
 *  - releaseLaneHold (src/core/fleet/runs-lane-hold.ts) appends
 *    `<iso>\t<lane>\theld->released\t<by>` per committed release —
 *    including the usage-reset-release sweep's 'reset-detect' rows.
 *  - Every line is exactly four tab-separated fields: the writers
 *    strip tabs/CR/LF from `by` and the hold reason's printable-ASCII
 *    contract excludes tabs, so a line with any other field count is
 *    off-contract. dispatchd's own autobackoff holds write slots.json
 *    directly and leave NO audit line — the log covers the TypeScript
 *    lane-capacity writers only, and a `held->released` row can
 *    legitimately appear with no recorded placement.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The log is read once through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched. A
 *    missing, unreadable or non-file log yields no items; a truncated
 *    tail is stated as a lower bound and malformed lines are counted,
 *    never guessed.
 *  - Rows count only under the writers' contract: canonical ISO-8601
 *    timestamp, lane id inside LANE_ID_RE's shape, change inside the
 *    three recorded forms with the writer's own bounds (hold minutes
 *    1..1440, safe-integer targets), and a non-empty printable tail.
 *  - Recurring means recorded across days: a hold cell emits at
 *    LANE_TARGET_MIN_ROWS hold audit lines across
 *    LANE_TARGET_MIN_DAYS distinct UTC days; a churn cell emits when a
 *    lane's in-window target transitions number the same bars AND ran
 *    in both directions — a monotone scale-up or wind-down is
 *    deliberate tuning, not oscillation. Each hold line is one audit
 *    event: self-expiring holds close silently and refreshes
 *    re-journal, so rows are a recorded floor of brake events, never
 *    claimed as distinct holds.
 *  - Healthy outcomes never emit: `held->released` rows and
 *    single-direction retarget runs count as context only — the
 *    capacity machinery working is not backlog work.
 *  - The journal describes this install's lane configuration — lanes,
 *    targets and hold reasons are local with no repository column —
 *    so like the sibling fleet-evidence feeds, items emit only when
 *    the backlog target's repository name is 'phantom'.
 *  - Tails are scrubbed, flattened and capped before quoting; the
 *    item id hashes the cell identity (kind + lane + repository —
 *    never the counts or timestamps), so a refresh re-derives the
 *    same ids and appendUserBacklogItems adds only what is new.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is lane × change-kind. */
export const LANE_TARGET_BACKLOG_MAX_ITEMS = 8;
const LANE_TARGET_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const LANE_TARGET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const LANE_TARGET_FUTURE_SKEW_MS = 60_000;
/** Audit lines a cell needs inside the window before its recurrence counts. */
export const LANE_TARGET_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const LANE_TARGET_MIN_DAYS = 2;
/**
 * Bounded tail for the log; every writer appends a sub-300-byte line
 * and lane-capacity changes are rare, so 256 KiB retains far more
 * history than the window can use.
 */
const LANE_TARGET_TAIL_BYTES = 256 * 1024;
/** The fleet's own repository label: the journal describes this install's lanes, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded tails are unbounded text; flatten, scrub and cap before quoting. */
const TAIL_MAX = 120;
/** Distinct recorded tails quoted inside one prompt before the rest is summarized. */
const TAIL_SAMPLES_MAX = 3;
/** Transition list quoted inside a churn prompt before the rest is summarized. */
const TRANSITION_SAMPLES_MAX = 8;
/** The lane id shape the writers enforce (LANE_ID_RE in runs-lane-targets.ts). */
const LANE_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** The canonical timestamp shape the writers stamp (Date#toISOString). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Retarget transition `<old>-><new>`; both sides are the writer's safe-integer targets. */
const RETARGET_RE = /^(\d{1,7})->(\d{1,7})$/;
/** Hold placement `hold <minutes>m`; the writer bounds minutes to 1..1440. */
const HOLD_RE = /^hold (\d{1,4})m$/;
const HOLD_MAX_MINUTES = 24 * 60;
const RELEASE_CHANGE = 'held->released';

export type LaneTargetCellKind = 'lane-hold' | 'lane-target-churn';

export interface LaneTargetChangesOptions {
  /** Backlog target in owner/name form; the journal describes the fleet install only. */
  repo: string;
  /** Runs dir holding queue/lane-target-changes.log; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LANE_TARGET_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default LANE_TARGET_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated audit line inside the evidence window. */
export interface LaneTargetRow {
  atMs: number;
  utcDay: string;
  lane: string;
  kind: 'retarget' | 'hold' | 'release';
  /** Retarget transitions only: recorded old and new targets. */
  from: number | null;
  to: number | null;
  /** Hold rows only: recorded minutes. */
  minutes: number | null;
  /** Best-effort actor: the tail before its first ': ' — 'lane-autohold', 'telegram', 'Phantom desktop'. */
  actor: string;
  /** The recorded tail, scrubbed/flattened/capped — quoted as evidence, never a key. */
  tail: string;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** Tails are free-form writer text: scrub secrets, flatten whitespace, cap. */
function cleanTail(value: string): string {
  const cleaned = scrubSecrets(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, TAIL_MAX);
}

/** Actor guess: the tail's text before the first ': ' — the writers' `${by}: ${reason}` hold shape puts the actor first. */
function cleanActor(tail: string): string {
  const head = tail.split(': ', 1)[0] ?? tail;
  const cleaned = head.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? 'unrecorded' : cleaned.slice(0, 60);
}

/**
 * Pure: validate one audit-log line against the writers' contract.
 * Exactly four tab-separated fields — ISO timestamp, lane id, one of
 * the three change shapes with the writer's own bounds, non-empty
 * tail — or the line is not evidence. Off-contract lines are counted
 * by the journal parse, never guessed.
 */
export function parseLaneTargetLine(line: string): LaneTargetRow | null {
  const fields = line.split('\t');
  if (fields.length !== 4) return null;
  const iso = fields[0] ?? '';
  const lane = fields[1] ?? '';
  const change = fields[2] ?? '';
  const tail = fields[3] ?? '';
  if (!ISO_RE.test(iso)) return null;
  const atMs = Date.parse(iso);
  if (!Number.isFinite(atMs)) return null;
  if (!LANE_RE.test(lane)) return null;
  if (tail.trim() === '') return null;
  const cleanedTail = cleanTail(tail);
  if (cleanedTail === '') return null;
  const actor = cleanActor(cleanedTail);
  const base = { atMs, utcDay: utcDayOf(atMs), lane, actor, tail: cleanedTail };
  const retarget = RETARGET_RE.exec(change);
  if (retarget !== null) {
    const from = Number(retarget[1]);
    const to = Number(retarget[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    return { ...base, kind: 'retarget', from, to, minutes: null };
  }
  const hold = HOLD_RE.exec(change);
  if (hold !== null) {
    const minutes = Number(hold[1]);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > HOLD_MAX_MINUTES) return null;
    return { ...base, kind: 'hold', from: null, to: null, minutes };
  }
  if (change === RELEASE_CHANGE) {
    return { ...base, kind: 'release', from: null, to: null, minutes: null };
  }
  return null;
}

/**
 * Pure: parse journal text into validated rows plus the count of
 * lines that were not on-contract audit lines — malformed shape,
 * foreign change tokens and off-contract fields are counted, never
 * guessed.
 */
export function parseLaneTargetChangesJournal(text: string): { rows: LaneTargetRow[]; invalidRows: number } {
  const rows: LaneTargetRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const row = parseLaneTargetLine(trimmed);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal's retained lines
// ---------------------------------------------------------------------------

interface HoldTally {
  rows: number;
  days: Set<string>;
  actors: Map<string, number>;
  tails: Map<string, number>;
  firstMs: number;
  lastMs: number;
}

interface ChurnTally {
  rows: number;
  days: Set<string>;
  actors: Map<string, number>;
  /** Ordered in-window transitions: [atMs, from, to]. */
  transitions: [number, number, number][];
  firstMs: number;
  lastMs: number;
}

export interface LaneTargetFold {
  /** In-window on-contract audit lines. */
  lines: number;
  /** On-contract lines outside the window — the tail read can reach past it. */
  outsideWindow: number;
  /** Lines that failed the writers' contract. */
  invalidRows: number;
  /** True when the bounded tail dropped older lines — counts are a recorded floor. */
  truncated: boolean;
  /** In-window release rows — context only, the machinery returning to normal. */
  releases: number;
  /** Per-lane in-window hold-line tallies. */
  holds: Map<string, HoldTally>;
  /** Per-lane in-window retarget tallies — every `old->new` line, churn decided at cell time. */
  retargets: Map<string, ChurnTally>;
}

/**
 * Pure: fold validated audit rows into per-lane tallies. Rows outside
 * the window never reach a cell; releases and monotone-direction
 * retarget lanes count as context. Churn candidacy (both directions
 * inside the window) is decided at cell time so the tally stays a
 * faithful record.
 */
export function foldLaneTargetRows(
  rows: readonly LaneTargetRow[],
  opts: { nowMs: number; windowMs?: number; truncated?: boolean; invalidRows?: number },
): LaneTargetFold {
  const fold: LaneTargetFold = {
    lines: 0, outsideWindow: 0, invalidRows: opts.invalidRows ?? 0,
    truncated: opts.truncated === true, releases: 0, holds: new Map(), retargets: new Map(),
  };
  const windowMs = opts.windowMs ?? LANE_TARGET_WINDOW_MS;
  for (const row of rows) {
    if (row.atMs < opts.nowMs - windowMs || row.atMs > opts.nowMs + LANE_TARGET_FUTURE_SKEW_MS) {
      fold.outsideWindow += 1;
      continue;
    }
    fold.lines += 1;
    if (row.kind === 'release') { fold.releases += 1; continue; }
    if (row.kind === 'hold') {
      let cell = fold.holds.get(row.lane);
      if (cell === undefined) {
        cell = { rows: 0, days: new Set(), actors: new Map(), tails: new Map(), firstMs: row.atMs, lastMs: row.atMs };
        fold.holds.set(row.lane, cell);
      }
      cell.rows += 1;
      cell.days.add(row.utcDay);
      cell.actors.set(row.actor, (cell.actors.get(row.actor) ?? 0) + 1);
      cell.tails.set(row.tail, (cell.tails.get(row.tail) ?? 0) + 1);
      cell.firstMs = Math.min(cell.firstMs, row.atMs);
      cell.lastMs = Math.max(cell.lastMs, row.atMs);
      continue;
    }
    // retarget
    let cell = fold.retargets.get(row.lane);
    if (cell === undefined) {
      cell = { rows: 0, days: new Set(), actors: new Map(), transitions: [], firstMs: row.atMs, lastMs: row.atMs };
      fold.retargets.set(row.lane, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.actors.set(row.actor, (cell.actors.get(row.actor) ?? 0) + 1);
    cell.transitions.push([row.atMs, row.from ?? 0, row.to ?? 0]);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface LaneTargetCell {
  kind: LaneTargetCellKind;
  lane: string;
  /** In-window adverse audit lines (holds) or transitions (churn). */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** Direction reversals for churn cells; null for hold cells. */
  reversals: number | null;
  /** The recorded transition sequence for churn cells (bounded). */
  transitions: string[] | null;
  /** Actor tally, most frequent first, bounded. */
  actors: [string, number][];
  /** Recorded tails, most frequent first, bounded — quoted as evidence. */
  tails: [string, number][];
  firstSeen: string | null;
  lastSeen: string | null;
  /** In-window on-contract lines overall — the context denominator. */
  records: number;
  /** In-window context lines — releases plus non-churn retarget rows. */
  context: number;
  /** Lines that failed the writers' contract inside the retained tail — never counted as evidence. */
  invalidRows: number;
  /** True when the tail read was truncated: counts are a recorded floor. */
  truncated: boolean;
}

const isoOrNull = (ms: number): string | null => new Date(ms).toISOString();

const topEntries = (map: Map<string, number>, max: number): [string, number][] =>
  [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);

const topTails = (map: Map<string, number>): [string, number][] => topEntries(map, TAIL_SAMPLES_MAX);

/**
 * Pure: recurring cells — a hold cell emits at the row and day bars; a
 * churn cell additionally requires the lane's in-window transitions to
 * have run in both directions (at least one increase and one decrease,
 * counted as direction reversals against the previous transition).
 * Sorted by rows desc, then kind, then lane for a stable order.
 */
export function laneTargetCells(fold: LaneTargetFold): LaneTargetCell[] {
  const cells: LaneTargetCell[] = [];
  // Context denominator: release rows plus retarget rows on lanes that
  // never emit a churn cell — decided in a first pass so the tally
  // quoted in prompts counts only non-adverse lines.
  const churnLanes = new Set<string>();
  const churnTallies = new Map<string, { cell: ChurnTally; reversals: number; transitions: string[] }>();
  for (const [lane, cell] of fold.retargets) {
    if (cell.rows < LANE_TARGET_MIN_ROWS || cell.days.size < LANE_TARGET_MIN_DAYS) continue;
    const ordered = [...cell.transitions].sort((a, b) => a[0] - b[0]);
    let ups = 0;
    let downs = 0;
    let reversals = 0;
    let lastDir = 0;
    for (const [, from, to] of ordered) {
      const dir = to > from ? 1 : to < from ? -1 : 0;
      if (dir === 0) continue;
      if (dir > 0) ups += 1; else downs += 1;
      if (lastDir !== 0 && dir !== lastDir) reversals += 1;
      lastDir = dir;
    }
    // Both directions inside the window is the churn bar — one up and
    // one down is already non-monotone; reversals only order the quote.
    if (ups === 0 || downs === 0) continue;
    churnLanes.add(lane);
    churnTallies.set(lane, {
      cell,
      reversals,
      transitions: ordered.slice(-TRANSITION_SAMPLES_MAX).map(([, from, to]) => `${from}->${to}`),
    });
  }
  let context = fold.releases;
  for (const [lane, cell] of fold.retargets) {
    if (!churnLanes.has(lane)) context += cell.rows;
  }
  for (const [lane, cell] of fold.holds) {
    if (cell.rows < LANE_TARGET_MIN_ROWS || cell.days.size < LANE_TARGET_MIN_DAYS) continue;
    cells.push({
      kind: 'lane-hold', lane, rows: cell.rows, days: [...cell.days].sort(),
      reversals: null, transitions: null,
      actors: topEntries(cell.actors, TAIL_SAMPLES_MAX), tails: topTails(cell.tails),
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      records: fold.lines, context, invalidRows: fold.invalidRows, truncated: fold.truncated,
    });
  }
  for (const [lane, tally] of churnTallies) {
    const cell = tally.cell;
    cells.push({
      kind: 'lane-target-churn', lane, rows: cell.rows, days: [...cell.days].sort(),
      reversals: tally.reversals, transitions: tally.transitions,
      actors: topEntries(cell.actors, TAIL_SAMPLES_MAX), tails: [],
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      records: fold.lines, context, invalidRows: fold.invalidRows, truncated: fold.truncated,
    });
  }
  return cells.sort((a, b) =>
    b.rows - a.rows || a.kind.localeCompare(b.kind) || a.lane.localeCompare(b.lane));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/queue/lane-target-changes.log — the fleet lane-capacity audit journal the guarded slots.json writers append: setLaneTarget (src/core/fleet/runs-lane-targets.ts) records `<iso>\\t<lane>\\t<old>-><target>\\t<by>` per committed concurrency-target change, placeLaneHold (src/core/fleet/runs-lane-hold-place.ts) records `<iso>\\t<lane>\\thold <minutes>m\\t<by>: <reason>` per committed hold (minutes 1..1440, reason printable ASCII 1..120), and releaseLaneHold (src/core/fleet/runs-lane-hold.ts) records `<iso>\\t<lane>\\theld->released\\t<by>` per committed release — the usage-reset-release sweep releases as \'reset-detect\'. Hold placers include `phm fleet lane-hold`, the lane-autohold empty-streak brake (src/core/fleet/lane-auto-hold.ts), the incident gate\'s recurring-class hold (src/core/fleet/incident-gate.ts), telegram commands and the desktop/verse control surfaces; retarget actors include \'Phantom desktop\', \'telegram\', \'phm autofix\' and the control APIs. dispatchd\'s own autobackoff holds write slots.json directly and leave NO audit line, so the log covers the TypeScript lane-capacity writers only and a release row can legitimately appear with no recorded placement. Each hold line is one placement-or-refresh audit event — self-expiring holds close silently — so rows are a recorded floor of brake events, never distinct holds.';

const REPRO = 'Reproduce the fold by reading <runs dir>/queue/lane-target-changes.log directly, keeping lines of exactly four tab-separated fields — canonical ISO-8601 timestamp, lane id matching /^[a-z][a-z0-9-]{1,30}$/, change inside `<int>-><int>` / `hold <1..1440>m` / `held->released`, non-empty printable tail — whose timestamp lands inside the window. Hold cells emit per lane at the row/day bars; churn cells emit per lane when the in-window retarget transitions ran in both directions. Releases and single-direction retarget runs are context. The writers and their gates are src/core/fleet/runs-lane-targets.ts, runs-lane-hold-place.ts and runs-lane-hold.ts; the lane state they audit lives in <runs>/queue/slots.json.';

const NO_CHANGE = 'If the window has rolled forward, the holds or retunes were deliberate operations (a deploy window, a quota wall the owner bridged, autofix retuning that stuck, a lane paused for maintenance), the churn was planned migration between targets, or this checkout is not the fleet install the journal describes — report no-change and name the evidence.';

const KIND_TITLE: Record<LaneTargetCellKind, string> = {
  'lane-hold': 'lane keeps needing emergency holds',
  'lane-target-churn': 'lane concurrency target keeps oscillating',
};

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: LaneTargetCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const truncatedText = (cell: LaneTargetCell): string =>
  cell.truncated ? ' The bounded tail read dropped older lines, so these counts cover only the retained suffix — a recorded floor, not the full stream.' : '';

const invalidText = (cell: LaneTargetCell): string =>
  cell.invalidRows > 0 ? ` ${cell.invalidRows} retained line(s) failed the writers' contract and were not counted.` : '';

const actorsText = (cell: LaneTargetCell): string => {
  if (cell.actors.length === 0) return '';
  const parts = cell.actors.map(([actor, n]) => `${actor} (${n})`);
  return ` Recorded actors: ${parts.join(', ')}.`;
};

const tailsText = (cell: LaneTargetCell): string => {
  if (cell.tails.length === 0) return '';
  const parts = cell.tails.map(([tail, n]) => `'${tail.slice(0, 80)}'${n > 1 ? ` ×${n}` : ''}`);
  return ` Recorded detail${cell.tails.length > 1 ? 's' : ''}: ${parts.join('; ')} — quoted as recorded.`;
};

const KIND_FIND: Record<LaneTargetCellKind, string> = {
  'lane-hold':
    `Find why lane '{lane}' keeps earning hold audit lines: each row is one placeLaneHold commit — 'lane-autohold' rows mean the empty-streak brake (src/core/fleet/lane-auto-hold.ts over lane-empty-streak.ts verdicts) kept finding the lane's launches all ending empty, 'incident-gate' rows mean a recurring incident class earned its 120-minute hold, and 'telegram'/'Phantom desktop'/CLI rows are deliberate operator holds. The recorded details name the reasons — start there: a lane-autohold loop means launches keep finishing empty (check the lane's jobs.jsonl outcomes and reward verdicts for what its work keeps doing), an incident-gate loop means one incident class keeps recurring (the gate's own ledger names it), and operator holds repeating mean the lane keeps needing protection (quota walls, burning jobs, maintenance). Check <runs>/queue/slots.json for the lane's current held state and held_reason, the lane's launch/outcome rows in metrics/jobs.jsonl, and whether the holds cluster on one cause the fleet's own machinery should fix instead of re-braking. The hold writers, the autohold planner and the incident gate are this repository's own; provider quota and host health behind them are owner-side — name them rather than working around them.`,
  'lane-target-churn':
    `Find why lane '{lane}'s concurrency target keeps moving in both directions: each row is one setLaneTarget commit and the recorded sequence — quoted bounded in the evidence — shows the oscillation (pause->resume flapping counts: target 0 is the lane's pause). Actors name the hands: 'phm autofix' retunes through host-node, 'Phantom desktop'/verse/telegram are deliberate operator or API changes, and mixed actors mean the writers are fighting — automation raising what a person keeps lowering, or two controllers with different objectives. Check whether the reversals cluster on one actor (that controller's logic is the suspect — src/core/autofix/host-node.ts for autofix, the lane-target surfaces for manual), whether they correlate with quota windows or incidents the lane kept hitting, and whether the target the lane settles on matches its real sustainable concurrency (the fleet board's running/target and the lane's outcome tallies in metrics/jobs.jsonl). If the oscillation is planned migration or deliberate tuning that has now settled — report no-change and name the evidence. The writers are this repository's own; provider quota posture behind the retunes is owner-side.`,
};

/** Id-safe fragment: backlog ids admit [A-Za-z0-9._-] only and cap at 120 chars total. */
const idSafe = (value: string, cap: number): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, cap) || 'unknown';

const WINDOW_DAYS = Math.round(LANE_TARGET_WINDOW_MS / 86_400_000);

function laneTargetItem(cell: LaneTargetCell, repo: string): CloudBacklogItem {
  const transitionsText = cell.transitions === null ? '' : ` The recorded in-window transitions — ${cell.transitions.join(', ')}${cell.transitions.length >= TRANSITION_SAMPLES_MAX ? ' (the newest, bounded)' : ''} — are quoted as recorded.`;
  const reversalText = cell.reversals === null ? '' : ` Direction reversals inside the window: ${cell.reversals}.`;
  // The hash covers the full cell identity (kind + lane + repo); the
  // readable fragments are bounded so the id stays inside ID_RE's
  // 120-char cap even for max-length fields.
  const hash = createHash('sha256')
    .update(`lane-target-changes:${repo.trim().toLowerCase()}:${cell.kind}:${cell.lane}`)
    .digest('hex').slice(0, 16);
  const id = `lane-target-changes-${cell.kind}-${idSafe(cell.lane, 30)}-${hash}`;
  const prompt = [
    `Phantom's lane-capacity audit journal keeps recording ${KIND_TITLE[cell.kind]} on lane '${cell.lane}' — ${cell.rows} audit line(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one committed lane-capacity audit line for '${cell.lane}'.${reversalText}${transitionsText}${actorsText(cell)}${tailsText(cell)}${seenText(cell)} ${cell.records} in-window on-contract line(s) were read; ${cell.context} recorded releases or single-direction retarget runs as context.${truncatedText(cell)}${invalidText(cell)}`,
    '',
    EVIDENCE,
    '',
    KIND_FIND[cell.kind].replaceAll('{lane}', cell.lane),
    '',
    `If the window has rolled forward, the holds or retunes were deliberate operations that have since settled, the churn was planned migration between targets, or this checkout is not the fleet install the journal describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: `Lane ${cell.lane}: ${KIND_TITLE[cell.kind]}`.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `lane-target-changes-${cell.kind}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the lane-capacity audit journal's recurring
 * adverse evidence. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function laneTargetChangesBacklogItems(opts: LaneTargetChangesOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || !CLOUD_REPO_PATTERN.test(repo)) return [];
    // The journal describes this install's lane configuration and
    // carries no repository column — like the sibling fleet-evidence
    // feeds, only the fleet's own repository inherits the items.
    if (fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    // Same precedence the sibling fleet reads apply: explicit dir,
    // then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(opts.homeDir ?? homedir(), '.ashlr-runs'));
    const ledger = await readLedgerTail(join(runsDir, 'queue', 'lane-target-changes.log'), LANE_TARGET_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const parsed = parseLaneTargetChangesJournal(ledger.text);
    const fold = foldLaneTargetRows(parsed.rows, {
      nowMs,
      windowMs: opts.windowMs,
      truncated: ledger.truncated,
      invalidRows: parsed.invalidRows,
    });
    const cells = laneTargetCells(fold);
    const limit = Math.max(1, Math.min(opts.limit ?? LANE_TARGET_BACKLOG_MAX_ITEMS, LANE_TARGET_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => laneTargetItem(cell, repo));
  } catch {
    return [];
  }
}
