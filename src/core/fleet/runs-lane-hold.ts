/**
 * Fleet lane hold release — POST /api/verse/fleet/control/holds lets Phantom
 * release a stale usage hold on a lane so the dispatcher launches on it at
 * its next tick, instead of hand-editing queue/slots.json. The write goes
 * through the same guarded path as runs-lane-targets.ts (lstat + owned +
 * nlink 1 + 64 KiB cap, O_NOFOLLOW read, JSON.stringify(raw, null, 1) +
 * newline, a `.slots-<uuid>.tmp` 0o600 temp + rename, and an
 * O_APPEND|O_NOFOLLOW audit line): the checks are copied, not shared, so this
 * file cannot weaken them.
 *
 * Dispatcher contract (contrib/mac/dispatchd.py): a held lane row carries
 * held / held_reason / held_by / held_until. held_by 'autobackoff' is the
 * fleet's own hold — software may release it. ANY other held_by is a hold a
 * person placed: the dispatcher never touches it and neither does this route
 * ('manual-hold'). Releasing sets held false — it stays a boolean because
 * this file's own source() checks (and readLaneTargets) require `held` on
 * every row; deleting it would make the rewrite unreadable to the very
 * surface that reports it — drops the three attribution keys, and stamps
 * last_change plus unheld_by, whose trailing ISO is how readLaneTargets
 * attributes the change.
 */
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { LANE_ID_RE, readLaneTargets, type LaneTargetsOptions, type LaneTargetsV1 } from './runs-lane-targets.js';

export const VERSE_FLEET_CONTROL_HOLDS_PATH = '/api/verse/fleet/control/holds';
export interface LaneHoldOptions extends LaneTargetsOptions { reason?: string }
export class LaneHoldError extends Error {
  readonly status: 422 | 503;
  constructor(readonly code: 'unknown-lane' | 'not-held' | 'manual-hold' | 'unavailable') {
    super({ 'unknown-lane': 'Unknown lane', 'not-held': 'Lane is not held', 'manual-hold': 'Lane was held manually', unavailable: 'Lane holds unavailable' }[code]);
    this.name = 'LaneHoldError';
    this.status = code === 'unavailable' ? 503 : 422;
  }
}
const MAX = 64 * 1024;
/** Printable ASCII only — the reason lands inside the unheld_by attribution. */
const REASON_RE = /^[\x20-\x7E]{0,120}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
export function parseLaneHoldAction(body: unknown): { lane: string; action: 'release'; reason?: string } | null {
  if (!object(body)) return null;
  const keys = Object.keys(body);
  if (keys.length < 2 || keys.length > 3 || keys.some((key) => key !== 'lane' && key !== 'action' && key !== 'reason')) return null;
  if (typeof body.lane !== 'string' || !LANE_ID_RE.test(body.lane) || body.action !== 'release') return null;
  if ('reason' in body && (typeof body.reason !== 'string' || !REASON_RE.test(body.reason))) return null;
  return 'reason' in body ? { lane: body.lane, action: 'release', reason: body.reason as string } : { lane: body.lane, action: 'release' };
}
async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || !owned(stat)) throw new LaneHoldError('unavailable');
}
async function source(opts: LaneHoldOptions) {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(root)) throw new LaneHoldError('unavailable');
  await directory(root);
  const queue = join(root, 'queue');
  await directory(queue);
  const path = join(queue, 'slots.json');
  const stat = await lstat(path);
  if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || stat.size > MAX) throw new LaneHoldError('unavailable');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: unknown;
  try {
    const current = await handle.stat();
    if (!current.isFile() || !owned(current) || current.nlink !== 1 || current.size > MAX || current.ino !== stat.ino || current.dev !== stat.dev) throw new LaneHoldError('unavailable');
    const bytes = Buffer.alloc(MAX + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX) throw new LaneHoldError('unavailable');
    raw = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
  if (!object(raw)) throw new LaneHoldError('unavailable');
  // Accept both the dispatcher's direct lane map and a wrapped lanes map.
  const lanes = Object.hasOwn(raw, 'lanes') ? raw.lanes : raw;
  if (!object(lanes)) throw new LaneHoldError('unavailable');
  for (const [lane, row] of Object.entries(lanes)) {
    if (!LANE_ID_RE.test(lane) || !object(row) || !integer(row.target) || !integer(row.floor) || !integer(row.ceiling) || row.floor > row.ceiling || typeof row.held !== 'boolean') throw new LaneHoldError('unavailable');
  }
  return { queue, path, raw, lanes: lanes as Record<string, Record<string, unknown>> };
}
export async function releaseLaneHold(lane: string, opts: LaneHoldOptions = {}): Promise<LaneTargetsV1> {
  let temp: string | undefined;
  try {
    const { queue, path, raw, lanes } = await source(opts);
    if (typeof lane !== 'string' || !LANE_ID_RE.test(lane) || !Object.hasOwn(lanes, lane)) throw new LaneHoldError('unknown-lane');
    const row = lanes[lane];
    if (!row.held) throw new LaneHoldError('not-held');
    // A hold a person placed is never released by software — the same rule
    // the dispatcher applies (any held_by other than 'autobackoff').
    if (row.held_by !== undefined && row.held_by !== 'autobackoff') throw new LaneHoldError('manual-hold');
    const now = (opts.now ?? (() => new Date()))();
    const iso = now.toISOString();
    const by = (opts.changedBy ?? 'Phantom desktop').replace(/[\t\r\n]/g, ' ');
    const reason = (opts.reason ?? '').replace(/[^\x20-\x7E]/g, ' ').slice(0, 120).trim();
    row.held = false;
    delete row.held_reason; delete row.held_by; delete row.held_until;
    row.last_change = Math.floor(now.getTime() / 1000);
    row.unheld_by = `${by} release${reason ? ` (${reason})` : ''} ${iso}`;
    const text = `${JSON.stringify(raw, null, 1)}\n`;
    if (Buffer.byteLength(text) > MAX) throw new LaneHoldError('unavailable');
    const logPath = join(queue, 'lane-target-changes.log');
    // Open the audit sink before committing; never follow symlinks or append to
    // non-regular/shared files. O_NONBLOCK also prevents FIFO hangs.
    const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await log.stat();
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new LaneHoldError('unavailable');
      temp = join(queue, `.slots-${randomUUID()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(text); } finally { await handle.close(); }
      await rename(temp, path);
      temp = undefined;
      await log.writeFile(`${iso}\t${lane}\theld->released\t${by}\n`);
    } finally { await log.close(); }
    return await readLaneTargets(opts);
  } catch (error) {
    if (error instanceof LaneHoldError) throw error;
    throw new LaneHoldError('unavailable');
  } finally { if (temp) await unlink(temp).catch(() => {}); }
}
