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
 */
import { KNOWN_STATUSES } from './lane-console.js';
import { laneLaunchTarget } from './lane-launch-target.js';
import { readyMarketLine } from './unfed-market.js';

/** Filler ids end in A, six or more digits, then Q8. */
export const FILLER_ID = /A\d{6,}Q8$/;

const PARKED = /^PARKED/i;

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
}

export interface StarvedLanes {
  /** Starved lanes sorted by name. */
  lanes: StarvedLane[];
  /** Lane-open market rows — runnable supply any lane may take; null when ready.tsv is absent. */
  openRows: number | null;
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

/** Pure: starved lanes from status.json text and ready.tsv text (null when absent). */
export function findStarvedLanes(
  statusJson: string, readyTsv: string | null, routerQueue?: string | null,
): StarvedLanes {
  const data: unknown = JSON.parse(statusJson);
  if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
  const split = new Map<string, { filler: number; real: number }>();
  let open = 0;
  const attribute = (id: string, lane: string): void => {
    const entry = split.get(lane) ?? { filler: 0, real: 0 };
    entry[FILLER_ID.test(id) ? 'filler' : 'real']++;
    split.set(lane, entry);
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
      const market = readyMarketLine(line, routerQueue);
      if (market === 'invalid') continue;
      if (market !== null) {
        if (market.hint === null) open++;
        else attribute(market.id, market.hint);
        continue;
      }
    }
    const row = queueRow(line);
    if (row !== null) attribute(row.id, row.lane);
  }
  const out: StarvedLane[] = [];
  for (const [lane, value] of Object.entries(data.lanes)) {
    if (!isRecord(value) || !count(value.running) || !count(value.target) || !count(value.queued)) {
      throw new Error('invalid lane');
    }
    // A shed lane at its launch ceiling has no free capacity.
    const target = laneLaunchTarget(value.target, count(value.effective_target) ? value.effective_target : null);
    if (value.held === true || value.running >= target || value.queued === 0) continue;
    const { filler, real } = split.get(lane) ?? { filler: 0, real: 0 };
    out.push({
      lane, running: value.running, target, queued: value.queued,
      ready: readyTsv === null ? null : filler + real,
      filler: readyTsv === null ? null : filler,
      real: readyTsv === null ? null : real,
    });
  }
  return { lanes: out.sort((a, b) => a.lane.localeCompare(b.lane)), openRows: readyTsv === null ? null : open };
}
