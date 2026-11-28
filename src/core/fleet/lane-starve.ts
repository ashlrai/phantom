/**
 * lane-starve.ts — core reader behind `phm fleet lane-starve`: lanes running
 * below their slot target while the router queue still holds work for them,
 * plus the ready.tsv filler/real split behind each lane's queued count.
 *
 * ready.tsv carries plain rows next to two parked encodings (the same
 * dialects dispatchd's `parked_row`, restock.py and dep-gate.ts recognize):
 *   job repo lane tier prompt [requirements]                   runnable row
 *   job repo PARKED-<reason>[.<lane>] tier prompt [req]        lane-column parked
 *   PARKED-<reason>[.<lane>] job lane tier repo prompt [req]   status-first parked
 * Parked rows wait on dependencies or rate limits — they are not runnable
 * queue work, so they never count toward `ready`/`filler`/`real`. For
 * status-first rows, only `READY` counts and the job id is in the second cell.
 *
 * Dispatcher rows (job repo lane tier prompt [requirements]) are attributed
 * by the hint the shared work market resolves, exactly like `fleet
 * launchable`: the requirements cell's `preferred_lane` — or the matching
 * router-queue.md `(attrs)` envelope for a spec-less row — wins over the
 * lane column, an explicit `null` or empty lane cell is lane-open shared
 * supply reported once as `openRows`, and a row the market would reject is
 * dead work, never counted. Rows in any other dialect keep the tolerant
 * lane-column read: they are not dispatcher jobs the market governs.
 * Each job contributes supply once, using its first valid row.
 */
import { KNOWN_STATUSES } from './lane-console.js';
import { dispatcherAdmissionHeadroom, laneLaunchTarget } from './lane-launch-target.js';
import {
  derivedRowCodes, marketContext, marketLaneView, readyMarketLine,
  type ReadyMarketRow, type UnfedMarketInputs,
} from './unfed-market.js';

/** Filler ids end in A, six or more digits, then Q8. */
export const FILLER_ID = /A\d{6,}Q8$/;

/**
 * dispatchd's per-job disk-deferral mark: `queue/run/<job>.diskguard` is
 * written when the dispatcher's disk reuse-only gate defers a non-reuse job
 * before market evaluation, and removed when that job launches. A waiting
 * ready row whose job id still carries the mark is disk-deferred, not merely
 * market-blocked — the evidence `deferred_after_selection` cannot see.
 */
export const DISKGUARD_SUFFIX = '.diskguard';

/** Job ids named by `.diskguard` marker entries in a queue/run listing; other entries are ignored. */
export function diskGuardedJobIds(entryNames: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const name of entryNames) {
    if (name.endsWith(DISKGUARD_SUFFIX)) ids.add(name.slice(0, -DISKGUARD_SUFFIX.length));
  }
  return ids;
}

const PARKED = /^PARKED/i;
const DISPATCHER_MAX_AGE_MS = 60_000;

export interface StarvedLane {
  lane: string;
  running: number;
  /** The launch target: configured target tightened by the controller's effective_target shed. */
  target: number;
  queued: number;
  /** Runnable (non-parked) rows in queue/ready.tsv for this lane, or null when absent. */
  ready: number | null;
  filler: number | null;
  real: number | null;
  /**
   * Work-market reason codes tallied over this lane's own market-evaluated
   * ready rows — why the shared market would not launch each row here — or
   * null when the market inputs (queue/slots.json and friends) cannot be
   * read. Rows in other ready.tsv dialects are not market jobs and are not
   * scored; `scored` counts the rows `blocked` covers.
   */
  blocked: Record<string, number> | null;
  /** Market-evaluated ready rows behind `blocked`; null when `blocked` is null. */
  scored: number | null;
  /**
   * This lane's market-evaluated ready rows whose job id carries the
   * dispatcher's `.diskguard` mark — the disk reuse-only gate deferred them
   * before market evaluation and they have not launched since (dispatchd
   * clears the mark on launch). Independent of `blocked`: a row can be both
   * disk-deferred and market-rejected. Null when the queue/run listing
   * could not be read; a provided listing yields a count, zero included.
   */
  diskguarded: number | null;
}

export interface StarvedLanes {
  /** Starved lanes sorted by name. */
  lanes: StarvedLane[];
  /** Lane-open market rows — runnable supply any lane may take; null when ready.tsv is absent. */
  openRows: number | null;
  /**
   * Market-evaluated ready rows carrying the `.diskguard` mark across every
   * lane plus lane-open supply; null when the queue/run listing could not be
   * read. Per-lane detail lives on each lane's `diskguarded`.
   */
  diskGuardedRows: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * True when a ready.tsv line is parked work in either encoding: the marker
 * leads the row (status-first) or sits in the lane cell (lane-column).
 * Mirrors dispatchd's `parked_row` and dep-gate's readyRow skip.
 */
export function isParkedReadyRow(cells: readonly string[]): boolean {
  return PARKED.test((cells[0] ?? '').trim()) || PARKED.test((cells[2] ?? '').trim());
}

interface QueueRow {
  id: string;
  lane: string;
}

/**
 * One runnable ready.tsv row (job id + lane), or null for blank lines,
 * comments, non-ready rows and rows missing either cell. Status-first rows put
 * the job id in the second cell. This is the tolerant fallback for rows that
 * are not dispatcher market jobs; dispatcher rows resolve through
 * readyMarketLine instead.
 */
function queueRow(line: string): QueueRow | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const cells = line.split('\t');
  if (isParkedReadyRow(cells)) return null;
  const first = cells[0]?.trim() ?? '';
  const lane = cells[2]?.trim() ?? '';
  if (!first || !lane) return null;
  const status = first.toUpperCase();
  if (KNOWN_STATUSES.has(status) && status !== 'READY') return null;
  const id = status === 'READY' ? cells[1]?.trim() : first;
  return id ? { id, lane } : null;
}

/**
 * Pure: supply and occupancy from a snapshot. Pass report time for a live
 * verdict. `market` carries the dispatcher's market inputs (slots.json,
 * models.json, budget-overrides.json, adaptive.json, HOLD); when they parse,
 * each starved lane also reports the work-market reason codes its own
 * ready rows are blocked by, exactly like `phm fleet unfed` derives them.
 * `market.nowMs` defaults to `now` so adaptive.json freshness is judged
 * against the same instant as the tick check. `diskGuarded` is the set of
 * job ids carrying the dispatcher's `.diskguard` mark (see
 * `diskGuardedJobIds`); when it is a set, each lane also counts its
 * market-evaluated rows the disk reuse-only gate deferred, and the result
 * totals them in `diskGuardedRows`. Pass `null`/omit when the queue/run
 * listing is unavailable — the counts then stay null, never a guessed zero.
 */
export function findStarvedLanes(
  statusJson: string, readyTsv: string | null, routerQueue?: string | null, now?: number,
  market?: UnfedMarketInputs, diskGuarded?: ReadonlySet<string> | null,
): StarvedLanes {
  const data: unknown = JSON.parse(statusJson);
  if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
  if (now !== undefined) {
    const tick = typeof data.last_tick === 'string' ? Date.parse(data.last_tick) : NaN;
    if (!Number.isFinite(tick) || tick > now || now - tick > DISPATCHER_MAX_AGE_MS) {
      throw new Error('unusable dispatcher tick');
    }
  }
  const ctx = marketContext(market === undefined ? undefined : { ...market, nowMs: market.nowMs ?? now });
  const split = new Map<string, { filler: number; real: number }>();
  const marketRows = new Map<string, ReadyMarketRow[]>();
  const diskCounts = new Map<string, number>();
  const countedJobs = new Set<string>();
  let diskGuardedTotal = 0;
  let open = 0;
  const attribute = (id: string, lane: string | null, row?: ReadyMarketRow): void => {
    if (countedJobs.has(id)) return;
    countedJobs.add(id);
    // Only market-evaluated rows can carry the dispatcher's disk mark: the
    // diskguard check runs on dispatcher jobs before market selection, and
    // tolerant ready.tsv dialects are not dispatcher jobs at all.
    if (row !== undefined && diskGuarded != null && diskGuarded.has(id)) {
      diskGuardedTotal++;
      if (lane !== null) diskCounts.set(lane, (diskCounts.get(lane) ?? 0) + 1);
    }
    if (lane === null) { open++; return; }
    const entry = split.get(lane) ?? { filler: 0, real: 0 };
    entry[FILLER_ID.test(id) ? 'filler' : 'real']++;
    split.set(lane, entry);
    if (row !== undefined) {
      const rows = marketRows.get(lane);
      if (rows === undefined) marketRows.set(lane, [row]);
      else rows.push(row);
    }
  };
  for (const line of readyTsv?.split('\n') ?? []) {
    const cells = line.split('\t');
    if (isParkedReadyRow(cells)) continue;
    const first = cells[0]?.trim() ?? '';
    const status = first.toUpperCase();
    // Status-first rows are not dispatcher jobs; bare rows get the market's
    // verdict first and fall back to the tolerant lane-column read only when
    // the line is not a dispatcher row at all.
    if (first !== '' && !KNOWN_STATUSES.has(status)) {
      const marketRow = readyMarketLine(line, routerQueue);
      if (marketRow === 'invalid') continue;
      if (marketRow !== null) {
        attribute(marketRow.id, marketRow.hint, marketRow);
        continue;
      }
    }
    const row = queueRow(line);
    if (row !== null) attribute(row.id, row.lane);
  }
  const out: StarvedLane[] = [];
  const paused = data.paused === true || (typeof data.paused === 'string' && data.paused.trim().length > 0);
  const admissionClosed = paused || dispatcherAdmissionHeadroom(data.admission, data.last_tick) === 0;
  for (const [lane, value] of Object.entries(data.lanes)) {
    if (!isRecord(value) || !count(value.running) || !count(value.target) || !count(value.queued)) {
      throw new Error('invalid lane');
    }
    // A shed lane at its launch ceiling has no free capacity.
    const target = laneLaunchTarget(value.target, count(value.effective_target) ? value.effective_target : null);
    if (admissionClosed || value.held === true || value.running >= target || value.queued === 0) continue;
    const { filler, real } = split.get(lane) ?? { filler: 0, real: 0 };
    let blocked: Record<string, number> | null = null;
    let scored: number | null = null;
    if (ctx !== null) {
      const view = marketLaneView(lane, value.running, target, value.held === true, ctx,
        typeof value.healthy === 'boolean' ? value.healthy : null);
      const rows = marketRows.get(lane) ?? [];
      scored = rows.length;
      blocked = {};
      for (const row of rows) {
        for (const code of derivedRowCodes(row, lane, view)) blocked[code] = (blocked[code] ?? 0) + 1;
      }
    }
    out.push({
      lane, running: value.running, target, queued: value.queued,
      ready: readyTsv === null ? null : filler + real,
      filler: readyTsv === null ? null : filler,
      real: readyTsv === null ? null : real,
      blocked, scored,
      diskguarded: diskGuarded == null ? null : diskCounts.get(lane) ?? 0,
    });
  }
  return {
    lanes: out.sort((a, b) => a.lane.localeCompare(b.lane)),
    openRows: readyTsv === null ? null : open,
    diskGuardedRows: diskGuarded == null ? null : diskGuardedTotal,
  };
}
