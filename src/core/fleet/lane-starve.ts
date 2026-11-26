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
 * queue work, so they never count toward `ready`/`filler`/`real`. A status
 * word in the first cell (`READY`, `CLAIMED`, ...) shifts the job id to the
 * second cell, matching dep-gate's readyRow layout.
 */
import { KNOWN_STATUSES } from './lane-console.js';
import { laneLaunchTarget } from './lane-launch-target.js';

/** Filler ids end in A, six or more digits, then Q8. */
export const FILLER_ID = /A\d{6,}Q8$/;

const PARKED = /^PARKED/i;

export interface StarvedLane {
  lane: string;
  running: number;
  /** The launch target: configured target tightened by the controller's effective_target shed. */
  target: number;
  queued: number;
  /** Runnable (non-parked) rows in queue/ready.tsv for this lane. */
  ready: number;
  filler: number;
  real: number;
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
 * comments, parked rows and rows missing either cell. Status-first rows put
 * the job id in the second cell.
 */
function queueRow(line: string): QueueRow | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const cells = line.split('\t');
  if (isParkedReadyRow(cells)) return null;
  const first = cells[0]?.trim() ?? '';
  const lane = cells[2]?.trim() ?? '';
  if (!first || !lane) return null;
  const id = (KNOWN_STATUSES.has(first.toUpperCase()) ? cells[1] : cells[0])?.trim() ?? '';
  return id ? { id, lane } : null;
}

/** Pure: starved lanes from status.json text and ready.tsv text ('' when absent). */
export function findStarvedLanes(statusJson: string, readyTsv: string): StarvedLane[] {
  const data: unknown = JSON.parse(statusJson);
  if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
  const split = new Map<string, { filler: number; real: number }>();
  for (const line of readyTsv.split('\n')) {
    const row = queueRow(line);
    if (!row) continue;
    const entry = split.get(row.lane) ?? { filler: 0, real: 0 };
    entry[FILLER_ID.test(row.id) ? 'filler' : 'real']++;
    split.set(row.lane, entry);
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
    out.push({ lane, running: value.running, target, queued: value.queued, ready: filler + real, filler, real });
  }
  return out.sort((a, b) => a.lane.localeCompare(b.lane));
}
