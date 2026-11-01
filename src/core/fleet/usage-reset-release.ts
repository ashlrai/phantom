/**
 * Usage-reset release — Phantom releases its own autobackoff usage holds once
 * the resource ledger proves the window reset. usage-reset-detect.ts already
 * computes 'reset-detected' / 'hold-expired' rows for the read-only
 * /api/verse/leader/resources/resets projection; dispatchd only enforces
 * held_until, so an autobackoff hold whose until-time was a guess (e.g. "held
 * until Nov 4" while the window already reset to 0%) outlived the real reset
 * until a person pressed release. This module closes the loop.
 *
 * A hold a person placed is never touched: planResetReleases requires
 * heldBy 'autobackoff' on top of the detector's releasable flag, and
 * releaseLaneHold re-checks held_by inside its guarded slots.json rewrite, so
 * a hold that flipped to manual between the read and the write still cannot
 * be released by software.
 *
 * Every release is recorded twice: one JSON line in
 * <runsDir>/queue/reset-releases.jsonl (the audit readResetReleases serves to
 * GET /api/verse/ops/reset-releases) and one LANE_HOLD line in
 * <runsDir>/dispatch-events.log so the Events pane narrates it exactly like a
 * dispatchd hold. The lane-target-changes.log audit line still comes from
 * releaseLaneHold itself.
 *
 * The loop is opt-in per process: the ops self-update GET starts it once when
 * dispatch is allowed (the desktop gear badge polls that route whenever the
 * app is open, so a live desktop is what arms it) and it is never armed under
 * Vitest. Every tick's outcome stays in module state; errors are kept, never
 * thrown out of the timer.
 */
import { constants, type Stats } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readUsageResets, type UsageResetRow, type UsageResetsV1 } from './usage-reset-detect.js';
import { releaseLaneHold, type LaneHoldOptions } from './runs-lane-hold.js';
import type { LaneTargetsV1 } from './runs-lane-targets.js';

export const RESET_RELEASES_FILE = 'queue/reset-releases.jsonl';
const DISPATCH_EVENTS_FILE = 'dispatch-events.log';
const RELEASED_BY = 'reset-detect';
const TAIL = 64 * 1024;

/** One released lane, as surfaced in the run result and the audit record. */
export interface ResetReleaseRow {
  lane: string;
  state: 'reset-detected' | 'hold-expired';
  usedPct: number | null;
  readingAsOf: string | null;
  heldUntil: string | null;
}
/** The durable audit line appended to queue/reset-releases.jsonl per release. */
export interface ResetReleaseRecord extends ResetReleaseRow {
  v: 1; at: string; by: typeof RELEASED_BY; reason: string;
}
export interface ResetReleaseResult {
  at: string; checked: number;
  released: ResetReleaseRow[];
  errors: { lane: string; message: string }[];
}
export interface ResetReleaseLoopState {
  started: boolean; lastRunAt: string | null;
  lastResult: ResetReleaseResult | null; lastError: string | null;
}
export interface RunResetReleaseOptions {
  runsDir?: string; now?: () => number;
  read?: (opts: { runsDir?: string; now?: () => number }) => Promise<UsageResetsV1>;
  release?: (lane: string, opts: LaneHoldOptions) => Promise<LaneTargetsV1>;
}
export interface ResetReleaseScheduler {
  set(fn: () => void, ms: number): { unref?(): unknown };
  clear(handle: { unref?(): unknown }): void;
}
export interface StartResetReleaseOptions {
  intervalMs?: number; runsDir?: string; now?: () => number;
  schedule?: ResetReleaseScheduler;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The only lanes Phantom may release on its own. A manual hold is never a candidate. */
export function planResetReleases(rows: UsageResetRow[]): UsageResetRow[] {
  return rows.filter((row) => row.releasable && row.heldBy === 'autobackoff'
    && (row.state === 'reset-detected' || row.state === 'hold-expired'));
}

function reasonFor(row: UsageResetRow): string {
  return row.state === 'hold-expired'
    ? `hold expired at ${row.heldUntil ?? 'unknown'}`
    : `window reset: reads ${row.usedPct ?? '?'}% at ${row.readingAsOf ?? 'unknown'}`;
}

/** Append one audit line the same guarded way lane-target-changes.log is written. */
async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error('invalid sink');
    await handle.writeFile(line);
  } finally { await handle.close(); }
}

export async function runResetReleaseOnce(opts: RunResetReleaseOptions = {}): Promise<ResetReleaseResult> {
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const at = new Date(nowMs).toISOString();
  const result: ResetReleaseResult = { at, checked: 0, released: [], errors: [] };
  const resets = await (opts.read ?? readUsageResets)({ runsDir: opts.runsDir, now: () => nowMs });
  result.checked = resets.rows.length;
  // Degraded or missing sources prove nothing about the real window — hold still.
  if (resets.sourceState !== 'healthy') return result;
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const release = opts.release ?? releaseLaneHold;
  for (const row of planResetReleases(resets.rows)) {
    const reason = reasonFor(row);
    try {
      await release(row.lane, { runsDir, now: () => new Date(nowMs), changedBy: RELEASED_BY, reason });
    } catch (error) {
      result.errors.push({ lane: row.lane, message: message(error) });
      continue;
    }
    const released: ResetReleaseRow = {
      lane: row.lane, state: row.state as ResetReleaseRow['state'],
      usedPct: row.usedPct, readingAsOf: row.readingAsOf, heldUntil: row.heldUntil,
    };
    result.released.push(released);
    const record: ResetReleaseRecord = { v: 1, at, by: RELEASED_BY, reason, ...released };
    try {
      await mkdir(join(runsDir, 'queue'), { recursive: true });
      await appendLine(join(runsDir, RESET_RELEASES_FILE), `${JSON.stringify(record)}\n`);
    } catch (error) {
      result.errors.push({ lane: row.lane, message: `release recorded but audit append failed: ${message(error)}` });
    }
    // Observational only — releaseLaneHold audits lane-target-changes.log but
    // not dispatch-events.log, so this line is what the Events pane narrates.
    await appendLine(join(runsDir, DISPATCH_EVENTS_FILE),
      `${at.slice(0, 19).replace('T', ' ')} LANE_HOLD released ${row.lane} by ${RELEASED_BY}: ${reason}\n`)
      .catch(() => undefined);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The in-process loop — one timer per process, armed by the ops self-update GET
// ---------------------------------------------------------------------------

const realScheduler: ResetReleaseScheduler = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (handle) => clearInterval(handle as NodeJS.Timeout),
};
const loopState: ResetReleaseLoopState = { started: false, lastRunAt: null, lastResult: null, lastError: null };
let scheduler = realScheduler;
let timer: { unref?(): unknown } | null = null;
let tickInFlight: Promise<void> | null = null;

/** Idempotent: a second call while running is a no-op. The first pass runs now. */
export function startResetReleaseLoop(opts: StartResetReleaseOptions = {}): void {
  if (loopState.started) return;
  loopState.started = true;
  scheduler = opts.schedule ?? realScheduler;
  const intervalMs = typeof opts.intervalMs === 'number' && Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 60_000;
  const fire = (): void => {
    if (tickInFlight) return;
    tickInFlight = runResetReleaseOnce({ runsDir: opts.runsDir, now: opts.now })
      .then((run) => {
        loopState.lastResult = run;
        loopState.lastRunAt = run.at;
        loopState.lastError = run.errors.length ? run.errors.map((e) => `${e.lane}: ${e.message}`).join('; ') : null;
      })
      .catch((error: unknown) => { loopState.lastError = message(error); })
      .finally(() => { tickInFlight = null; });
  };
  timer = scheduler.set(fire, intervalMs);
  timer.unref?.();
  fire();
}

export function getResetReleaseState(): ResetReleaseLoopState {
  return { ...loopState };
}

export function stopResetReleaseLoopForTest(): void {
  if (timer) { scheduler.clear(timer); timer = null; }
  scheduler = realScheduler;
  loopState.started = false;
  loopState.lastRunAt = null;
  loopState.lastResult = null;
  loopState.lastError = null;
}

/** Newest-first audit read: the last 64 KiB of reset-releases.jsonl, malformed lines skipped. */
export async function readResetReleases(runsDir?: string, limit = 20): Promise<ResetReleaseRecord[]> {
  const root = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const cap = Number.isFinite(limit) ? Math.min(200, Math.max(0, Math.floor(limit))) : 20;
  let tail: string;
  try {
    const file = await open(join(root, RESET_RELEASES_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('invalid source');
      const start = Math.max(0, info.size - TAIL);
      const bytes = Buffer.alloc(Math.min(info.size, TAIL));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      tail = bytes.subarray(0, offset).toString('utf8');
      const firstNewline = tail.indexOf('\n');
      if (start && firstNewline >= 0) tail = tail.slice(firstNewline + 1);
    } finally { await file.close(); }
  } catch { return []; }
  const records: ResetReleaseRecord[] = [];
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!object(row) || typeof row.lane !== 'string' || typeof row.at !== 'string') continue;
    records.push({
      v: 1, at: row.at, lane: row.lane,
      state: row.state === 'hold-expired' ? 'hold-expired' : 'reset-detected',
      usedPct: typeof row.usedPct === 'number' && Number.isFinite(row.usedPct) ? row.usedPct : null,
      readingAsOf: text(row.readingAsOf), heldUntil: text(row.heldUntil),
      by: RELEASED_BY, reason: text(row.reason) ?? '',
    });
  }
  return records.reverse().slice(0, cap);
}
