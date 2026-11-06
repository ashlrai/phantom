/**
 * Fleet lane hold place — `ashlr fleet lane-hold` lets Phantom put a
 * bounded, self-expiring hold on a lane so a lane burning jobs on dead
 * credentials stops launching without a person hand-editing
 * queue/slots.json. The write goes through the same guarded path as
 * runs-lane-hold.ts (lstat + owned + nlink 1 + 64 KiB cap, O_NOFOLLOW
 * read, JSON.stringify(raw, null, 1) + newline, a `.slots-<uuid>.tmp`
 * 0o600 temp + rename, and an O_APPEND|O_NOFOLLOW audit line): the checks
 * are copied, not shared, so this file cannot weaken them.
 *
 * Dispatcher contract (contrib/mac/dispatchd.py): a held lane row carries
 * held / held_reason / held_by / held_until. held_by 'autobackoff' is the
 * fleet's own hold and a 'phantom …' hold is one this writer placed — both
 * may be refreshed. ANY other held_by (or a held row with no attribution at
 * all, like dispatchd's "credits exhausted" holds) is a hold a person
 * placed and is refused ('manual-hold'): software never overwrites it.
 * A Phantom hold always carries held_until ≤ 24 h out; dispatchd enforces
 * held_until, so a hold nobody remembers expires on its own. held_until is
 * written as a seconds-precision ISO datetime — the form dispatchd writes
 * (ab_iso) and every reader parses (nullableString + Date.parse) — while
 * last_change stays epoch seconds, matching the other rows.
 */
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { LaneHoldError, type LaneHoldOptions } from './runs-lane-hold.js';
import { LANE_ID_RE, readLaneTargets, type LaneTargetsOptions, type LaneTargetsV1 } from './runs-lane-targets.js';

export interface PlaceLaneHoldOptions extends LaneTargetsOptions { minutes: number; reason: string }
const MAX = 64 * 1024;
const MAX_MINUTES = 24 * 60;
/** Printable ASCII only — the reason lands inside held_by attribution and two log lines. */
const REASON_RE = /^[\x20-\x7E]{0,120}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || !owned(stat)) throw new LaneHoldError('unavailable');
}
// Copy of the private source() in runs-lane-hold.ts — the guarded slots.json
// reader this writer must satisfy exactly. It additionally returns `root`
// (the resolved runs dir) so the dispatch-events narration lands beside it.
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
  return { root, queue, path, raw, lanes: lanes as Record<string, Record<string, unknown>> };
}
export async function placeLaneHold(lane: string, opts: PlaceLaneHoldOptions): Promise<LaneTargetsV1> {
  // Argument contract failures are caller bugs — TypeError before any file
  // is touched, so a bad call can never rewrite slots.json.
  if (!Number.isSafeInteger(opts.minutes) || opts.minutes < 1 || opts.minutes > MAX_MINUTES) throw new TypeError('minutes must be an integer 1..1440');
  const reason = typeof opts.reason === 'string' && REASON_RE.test(opts.reason) ? opts.reason.trim() : '';
  if (!reason) throw new TypeError('reason must be printable ASCII, 1..120 chars');
  let temp: string | undefined;
  try {
    const { root, queue, path, raw, lanes } = await source(opts);
    if (typeof lane !== 'string' || !LANE_ID_RE.test(lane) || !Object.hasOwn(lanes, lane)) throw new LaneHoldError('unknown-lane');
    const row = lanes[lane];
    // A hold a person placed is never overwritten — the same rule the
    // dispatcher applies (any held_by other than 'autobackoff'), relaxed
    // only for holds this writer placed ('phantom …') so they refresh.
    if (row.held === true) {
      const holder = row.held_by;
      if (holder !== 'autobackoff' && !(typeof holder === 'string' && holder.startsWith('phantom'))) throw new LaneHoldError('manual-hold');
    }
    const now = (opts.now ?? (() => new Date()))();
    const iso = now.toISOString();
    const by = (opts.changedBy ?? 'Phantom desktop').replace(/[\t\r\n]/g, ' ');
    const until = new Date(now.getTime() + opts.minutes * 60_000);
    const untilIso = until.toISOString().replace(/\.\d{3}Z$/, 'Z');
    row.held = true;
    row.held_reason = reason;
    row.held_by = `phantom ${by} ${iso}`;
    row.held_until = untilIso;
    row.last_change = Math.floor(now.getTime() / 1000);
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
      await log.writeFile(`${iso}\t${lane}\thold ${opts.minutes}m\t${by}: ${reason}\n`);
    } finally { await log.close(); }
    // Observational only — the audit line above is durable; this is the line
    // the Events pane narrates, exactly like dispatchd's own LANE_HOLD rows
    // (usage-reset-release.ts does the same for releases). A failed append
    // warns and never fails the hold that already committed.
    try {
      const events = await open(join(root, 'dispatch-events.log'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const stat = await events.stat();
        if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error('invalid sink');
        await events.writeFile(`${iso.slice(0, 19).replace('T', ' ')} LANE_HOLD placed ${lane} by phantom: ${reason} (until ${untilIso})\n`);
      } finally { await events.close(); }
    } catch (error) {
      process.stderr.write(`warning: could not append dispatch-events line: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return await readLaneTargets(opts);
  } catch (error) {
    if (error instanceof LaneHoldError) throw error;
    throw new LaneHoldError('unavailable');
  } finally { if (temp) await unlink(temp).catch(() => {}); }
}
