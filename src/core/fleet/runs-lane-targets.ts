import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const VERSE_FLEET_CONTROL_LANES_PATH = '/api/verse/fleet/control/lanes';
export const LANE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
export interface LaneTargetRow { lane: string; target: number; floor: number; ceiling: number; held: boolean; heldReason: string | null; heldUntil: string | null; lastChange: string | null; changedBy: string | null }
export interface LaneTargetsV1 { v: 1; generatedAt: string; sourceState: 'healthy' | 'missing' | 'degraded'; lanes: LaneTargetRow[] }
export interface LaneTargetsOptions { runsDir?: string; now?: () => Date; changedBy?: string }
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
  for (const [lane, row] of Object.entries(lanes)) {
    if (!LANE_ID_RE.test(lane) || !object(row) || !integer(row.target) || !integer(row.floor) || !integer(row.ceiling) || row.floor > row.ceiling || typeof row.held !== 'boolean') throw new LaneTargetError('unavailable');
  }
  return { queue, path, raw, lanes: lanes as Record<string, Record<string, unknown>> };
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
export async function readLaneTargets(opts: LaneTargetsOptions = {}): Promise<LaneTargetsV1> {
  const state: LaneTargetsV1 = { v: 1, generatedAt: (opts.now ?? (() => new Date()))().toISOString(), sourceState: 'healthy', lanes: [] };
  try {
    const { lanes } = await source(opts);
    state.lanes = Object.entries(lanes).map(([lane, row]) => ({ lane, target: row.target as number, floor: row.floor as number, ceiling: row.ceiling as number, held: row.held as boolean, heldReason: nullableString(row.held_reason), heldUntil: nullableString(row.held_until), lastChange: epochIso(row.last_change), changedBy: changedBy(row) }));
  } catch (error) { state.sourceState = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded'; }
  return state;
}
export async function setLaneTarget(lane: string, target: number, opts: LaneTargetsOptions = {}): Promise<LaneTargetsV1> {
  let temp: string | undefined;
  try {
    const { queue, path, raw, lanes } = await source(opts);
    if (typeof lane !== 'string' || !LANE_ID_RE.test(lane) || !Object.hasOwn(lanes, lane)) throw new LaneTargetError('unknown-lane');
    const row = lanes[lane];
    if (!integer(target) || target < (row.floor as number) || target > (row.ceiling as number)) throw new LaneTargetError('out-of-range');
    const now = (opts.now ?? (() => new Date()))();
    const iso = now.toISOString();
    const by = (opts.changedBy ?? 'Phantom desktop').replace(/[\t\r\n]/g, ' ');
    const old = row.target;
    row.target = target;
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
