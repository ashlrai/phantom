import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const VERSE_FLEET_CONTROL_LANES_PATH = '/api/verse/fleet/control/lanes';
export const LANE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** Existing fleet-wide limit and attribution keys, never lane IDs. */
export const GLOBAL_SLOT_KEYS: ReadonlySet<string> = new Set(['hard_cap', 'last_change_by']);
export interface LaneTargetRow { lane: string; target: number; floor: number; ceiling: number | null; held: boolean; heldReason: string | null; heldUntil: string | null; pausedFrom: number | null; lastChange: string | null; changedBy: string | null }
/** A lane row that was left out of a read, with a plain-word reason. */
export interface LaneSkip { lane: string; reason: string }
export interface LaneTargetsV1 { v: 1; generatedAt: string; sourceState: 'healthy' | 'missing' | 'degraded'; lanes: LaneTargetRow[]; skipped?: LaneSkip[] }
export interface LaneTargetsOptions { runsDir?: string; now?: () => Date; changedBy?: string; dryRun?: boolean }
export class LaneTargetError extends Error {
  readonly status: 422 | 503;
  constructor(readonly code: 'unknown-lane' | 'out-of-range' | 'unavailable') {
    super({ 'unknown-lane': 'Unknown lane', 'out-of-range': 'Target is outside lane bounds', unavailable: 'Lane targets unavailable' }[code]);
    this.name = 'LaneTargetError';
    this.status = code === 'unavailable' ? 503 : 422;
  }
}
const MAX = 64 * 1024;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : null;
export function parseLaneTargetAction(body: unknown): { lane: string; target: number } | null {
  if (!object(body) || Object.keys(body).length !== 2 || typeof body.lane !== 'string' || !LANE_ID_RE.test(body.lane) || !integer(body.target)) return null;
  return { lane: body.lane, target: body.target };
}
/**
 * Why a slots.json lane row cannot be used, in plain words, or null when it is
 * fine. The dispatch daemon writes `"ceiling": null` (or omits it) for a lane
 * with no fixed ceiling, so only a present non-null ceiling must be a count at
 * or above the floor. Extra keys (pause_new_until, backoff_note, ...) are fine.
 */
export function laneRowProblem(lane: string, row: unknown): string | null {
  if (!LANE_ID_RE.test(lane)) return 'the lane name is not valid';
  if (!object(row)) return 'the lane entry is not an object';
  if (!integer(row.target)) return 'target is not a whole number';
  if (!integer(row.floor)) return 'floor is not a whole number';
  if (row.ceiling !== undefined && row.ceiling !== null) {
    if (!integer(row.ceiling)) return 'ceiling is not a whole number (use null for no fixed ceiling)';
    if (row.floor > row.ceiling) return 'floor is above ceiling';
  }
  return null;
}
/**
 * True when the file as a whole cannot be trusted: a garbled last_change_by or
 * a lane whose hold flag is not true/false (never read as permission to launch
 * work). Everything else wrong with a lane only skips that lane.
 */
export function slotsFileUnsafe(lanes: Record<string, unknown>): boolean {
  return Object.entries(lanes).some(([lane, row]) => lane === 'last_change_by' ? typeof row !== 'string'
    : !GLOBAL_SLOT_KEYS.has(lane) && object(row) && Object.hasOwn(row, 'held') && typeof row.held !== 'boolean');
}
/** The most a lane may be set to: hard_cap when present, else the ceiling, else no limit. */
export function laneTop(row: Record<string, unknown>): number {
  const caps = [row.hard_cap, row.ceiling].filter(integer);
  return caps.length ? Math.min(...caps) : Number.POSITIVE_INFINITY;
}
async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || !owned(stat)) throw new LaneTargetError('unavailable');
}
async function source(opts: LaneTargetsOptions) {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(root)) throw new LaneTargetError('unavailable');
  await directory(root);
  const queue = join(root, 'queue');
  await directory(queue);
  const path = join(queue, 'slots.json');
  const stat = await lstat(path);
  if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || stat.size > MAX) throw new LaneTargetError('unavailable');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: unknown;
  try {
    const current = await handle.stat();
    if (!current.isFile() || !owned(current) || current.nlink !== 1 || current.size > MAX || current.ino !== stat.ino || current.dev !== stat.dev) throw new LaneTargetError('unavailable');
    const bytes = Buffer.alloc(MAX + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX) throw new LaneTargetError('unavailable');
    raw = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
  if (!object(raw)) throw new LaneTargetError('unavailable');
  // Accept both the dispatcher's direct lane map and a wrapped lanes map.
  const lanes = Object.hasOwn(raw, 'lanes') ? raw.lanes : raw;
  if (!object(lanes)) throw new LaneTargetError('unavailable');
  if (slotsFileUnsafe(lanes)) throw new LaneTargetError('unavailable');
  // One bad lane row is skipped with a reason; it never fails the whole file.
  const good: Record<string, Record<string, unknown>> = {};
  const skipped: LaneSkip[] = [];
  for (const [lane, row] of Object.entries(lanes)) {
    if (GLOBAL_SLOT_KEYS.has(lane)) continue;
    const reason = laneRowProblem(lane, row);
    if (reason) skipped.push({ lane, reason });
    else good[lane] = row as Record<string, unknown>;
  }
  return { queue, path, raw, lanes: good, skipped };
}
function epochIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function changedBy(row: Record<string, unknown>): string | null {
  // Latest trailing ISO timestamp wins; ties/unparseable values prefer unheld,
  // then held, then changed. Preserve the original attribution string.
  const entries = [row.unheld_by, row.held_by, row.changed_by].filter((v): v is string => typeof v === 'string');
  const time = (v: string) => Date.parse(v.match(/\d{4}-\d{2}-\d{2}T\S+$/)?.[0] ?? '') || 0;
  return entries.sort((a, b) => time(b) - time(a))[0] ?? null;
}
// paused_from is the pre-pause target written by setLaneTarget. Only a
// plausible positive target inside the lane's current bounds is surfaced;
// anything else stored reads as "nothing remembered".
function pausedFrom(row: Record<string, unknown>): number | null {
  const value = row.paused_from;
  return integer(value) && value > 0 && value >= (row.floor as number) && value <= laneTop(row) ? value : null;
}
export async function readLaneTargets(opts: LaneTargetsOptions = {}): Promise<LaneTargetsV1> {
  const state: LaneTargetsV1 = { v: 1, generatedAt: (opts.now ?? (() => new Date()))().toISOString(), sourceState: 'healthy', lanes: [] };
  try {
    const { lanes, skipped } = await source(opts);
    if (skipped.length) state.skipped = skipped;
    state.lanes = Object.entries(lanes).map(([lane, row]) => ({ lane, target: row.target as number, floor: row.floor as number, ceiling: integer(row.ceiling) ? row.ceiling : null, held: row.held === true, heldReason: nullableString(row.held_reason), heldUntil: nullableString(row.held_until), pausedFrom: pausedFrom(row), lastChange: epochIso(row.last_change), changedBy: changedBy(row) }));
  } catch (error) { state.sourceState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded'; }
  return state;
}
export async function setLaneTarget(lane: string, target: number, opts: LaneTargetsOptions = {}): Promise<LaneTargetsV1> {
  let temp: string | undefined;
  try {
    const { queue, path, raw, lanes, skipped } = await source(opts);
    if (skipped.some(s => s.lane === lane)) throw new LaneTargetError('unavailable');
    if (typeof lane !== 'string' || !LANE_ID_RE.test(lane) || !Object.hasOwn(lanes, lane)) throw new LaneTargetError('unknown-lane');
    const row = lanes[lane];
    // hard_cap (RQ-LOADGATE-1) bounds a target like the ceiling does; dispatchd would clamp it on the next tick anyway.
    if (!integer(target) || target < (row.floor as number) || target > laneTop(row)) throw new LaneTargetError('out-of-range');
    if (opts.dryRun) return readLaneTargets(opts);
    const now = (opts.now ?? (() => new Date()))();
    const iso = now.toISOString();
    const by = (opts.changedBy ?? 'Phantom desktop').replace(/[\t\r\n]/g, ' ');
    const old = row.target as number;
    row.target = target;
    if (target === 0 && old > 0) row.paused_from = old;
    else if (target > 0) delete row.paused_from;
    row.last_change = Math.floor(now.getTime() / 1000);
    row.changed_by = `${by} ${iso}`;
    const text = `${JSON.stringify(raw, null, 1)}\n`;
    if (Buffer.byteLength(text) > MAX) throw new LaneTargetError('unavailable');
    const logPath = join(queue, 'lane-target-changes.log');
    // Open the audit sink before committing; never follow symlinks or append to
    // non-regular/shared files. O_NONBLOCK also prevents FIFO hangs.
    const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await log.stat();
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new LaneTargetError('unavailable');
      temp = join(queue, `.slots-${randomUUID()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(text); } finally { await handle.close(); }
      await rename(temp, path);
      temp = undefined;
      await log.writeFile(`${iso}\t${lane}\t${old}->${target}\t${by}\n`);
    } finally { await log.close(); }
    return await readLaneTargets(opts);
  } catch (error) {
    if (error instanceof LaneTargetError) throw error;
    throw new LaneTargetError('unavailable');
  } finally { if (temp) await unlink(temp).catch(() => {}); }
}
