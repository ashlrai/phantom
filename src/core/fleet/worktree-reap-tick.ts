/**
 * The self-tick's worktree reap: when job worktrees pile up past the warning
 * level, run the existing safe reap (`readWorktrees('apply')`, never force) on a
 * schedule so disk stops growing between human visits.
 *
 * Bounds: at most WORKTREE_REAP_CAP removals per run and one run per 30 minutes.
 * Kill switch: a file, `<runs dir>/queue/worktree-reap.off`, or the fleet-wide
 * `<runs dir>/ORCH_OFF`. Creating either one turns the reap into a no-op.
 * The last run is kept in `<runs dir>/queue/worktree-reap-last.json` and read
 * back by `phm worktrees --reap --status`. Removal itself, its safety gates and
 * the removal log stay in worktrees.ts; this file adds no second removal path.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  countJobWorktrees, formatBytes, readWorktrees, WORKTREES_WARN_AT, type WorktreesDeps, type WorktreesReport,
} from './worktrees.js';

export const WORKTREE_REAP_STATUS_SCHEMA = 'worktrees.reap-status.v1';
export const WORKTREE_REAP_CAP = 25;
export const WORKTREE_REAP_MIN_GAP_MS = 30 * 60_000;
export const WORKTREE_REAP_OFF_FILE = join('queue', 'worktree-reap.off');
const LAST_FILE = join('queue', 'worktree-reap-last.json');

/** What the last run did. Numbers are null when a source could not be read. */
export interface WorktreeReapLast {
  at: string;
  /** Job worktrees counted before the run. */
  total: number;
  removed: number;
  /** Safe rows left for the next run because of the cap. */
  waiting: number;
  /** Rows not removed, by plain reason (hold or refusal). */
  skipped: Record<string, number>;
  /** Bytes of the removed worktrees; a floor when bytesComplete is false. */
  bytesFreed: number;
  bytesComplete: boolean;
}

export interface WorktreeReapStatus {
  schema: typeof WORKTREE_REAP_STATUS_SCHEMA;
  /** true = off switch present, null = could not tell. */
  off: boolean | null;
  warnAt: number;
  cap: number;
  minGapMinutes: number;
  /** null until the reap has run once, or when the record is unreadable. */
  last: WorktreeReapLast | null;
  /** Why `last` is null: 'never-run' or 'unreadable'. */
  lastNote: 'never-run' | 'unreadable' | null;
  /** ISO time the next run may happen; null when unknown. */
  nextRunAfter: string | null;
}

export type WorktreeReapTickResult =
  | { state: 'skipped'; reason: string }
  | { state: 'ran'; last: WorktreeReapLast };

export interface WorktreeReapTickOptions {
  runsDir: string;
  /** Without apply nothing is removed and nothing is recorded. */
  apply: boolean;
  now: number;
  /** Seams for the worktree readers, remover and clock; tests use fixtures. */
  deps?: WorktreesDeps;
}

const off = (runsDir: string): boolean => existsSync(join(runsDir, WORKTREE_REAP_OFF_FILE)) || existsSync(join(runsDir, 'ORCH_OFF'));

/** Pure: fold one apply report into the last-run record. */
export function summarizeReap(report: WorktreesReport, now: number): WorktreeReapLast {
  const skipped: Record<string, number> = {};
  const bump = (reason: string): void => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const row of report.rows) if (!row.safe && row.hold) bump(row.hold);
  const removed = new Set<string>();
  for (const removal of report.removals ?? []) {
    if (removal.status === 'removed') removed.add(removal.job);
    else bump(removal.reason ?? removal.status);
  }
  let bytesFreed = 0;
  for (const row of report.rows) if (removed.has(row.job)) bytesFreed += row.bytes ?? 0;
  const attempted = (report.removals ?? []).length;
  return {
    at: new Date(now).toISOString(), total: report.counts.total, removed: removed.size,
    waiting: Math.max(0, report.counts.safe - attempted), skipped,
    bytesFreed, bytesComplete: report.reclaimableComplete && report.rows.filter(r => removed.has(r.job)).every(r => r.bytes !== null),
  };
}

async function readLast(runsDir: string): Promise<{ last: WorktreeReapLast | null; note: WorktreeReapStatus['lastNote'] }> {
  let text: string;
  try { text = await readFile(join(runsDir, LAST_FILE), 'utf8'); }
  catch (error) { return { last: null, note: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'never-run' : 'unreadable' }; }
  try {
    const raw = JSON.parse(text) as Partial<WorktreeReapLast>;
    const ok = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)) && [raw.total, raw.removed, raw.waiting, raw.bytesFreed].every(n => typeof n === 'number' && Number.isFinite(n))
      && typeof raw.bytesComplete === 'boolean' && !!raw.skipped && typeof raw.skipped === 'object';
    return ok ? { last: raw as WorktreeReapLast, note: null } : { last: null, note: 'unreadable' };
  } catch { return { last: null, note: 'unreadable' }; }
}

/** Read-only: the kill switch, the bounds and the last run. */
export async function readWorktreeReapStatus(runsDir: string): Promise<WorktreeReapStatus> {
  const { last, note } = await readLast(runsDir);
  const next = last ? new Date(Date.parse(last.at) + WORKTREE_REAP_MIN_GAP_MS).toISOString() : null;
  return {
    schema: WORKTREE_REAP_STATUS_SCHEMA, off: off(runsDir), warnAt: WORKTREES_WARN_AT, cap: WORKTREE_REAP_CAP,
    minGapMinutes: WORKTREE_REAP_MIN_GAP_MS / 60_000, last, lastNote: note, nextRunAfter: next,
  };
}

/** One bounded reap. Never throws: a failure is a plain skipped reason. */
export async function runWorktreeReapTick(options: WorktreeReapTickOptions): Promise<WorktreeReapTickResult> {
  const { runsDir, now } = options;
  try {
    if (off(runsDir)) return { state: 'skipped', reason: 'off: worktree-reap.off is present' };
    if (!options.apply) return { state: 'skipped', reason: 'dry-run: nothing removed' };
    const { last } = await readLast(runsDir);
    if (last && now - Date.parse(last.at) < WORKTREE_REAP_MIN_GAP_MS) return { state: 'skipped', reason: 'ran less than 30 minutes ago' };
    const deps: WorktreesDeps = { ...options.deps, now, runsRoot: runsDir };
    const total = await countJobWorktrees(deps);
    if (total <= WORKTREES_WARN_AT) return { state: 'skipped', reason: `${total} job worktrees, at or below the warning level of ${WORKTREES_WARN_AT}` };
    const report = await readWorktrees('apply', { ...deps, maxRemovals: WORKTREE_REAP_CAP });
    const record = summarizeReap(report, now);
    const file = join(runsDir, LAST_FILE);
    await mkdir(join(runsDir, 'queue'), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temp, file);
    return { state: 'ran', last: record };
  } catch {
    return { state: 'skipped', reason: 'worktree reap failed; nothing recorded' };
  }
}

export function formatWorktreeReapStatus(status: WorktreeReapStatus): string[] {
  const lines = [`Scheduled reap: ${status.off === null ? 'unknown (cannot read the off switch)' : status.off ? 'OFF (worktree-reap.off is present)' : 'on'}. Runs when over ${status.warnAt} worktrees, up to ${status.cap} removals, once per ${status.minGapMinutes} minutes.`];
  if (!status.last) {
    lines.push(status.lastNote === 'unreadable' ? 'Last run: unknown (record unreadable).' : 'Last run: never.');
    return lines;
  }
  const l = status.last;
  const reasons = Object.entries(l.skipped).sort(([a], [b]) => a.localeCompare(b)).map(([reason, n]) => `${n} ${reason.replace(/-/g, ' ')}`);
  lines.push(`Last run: ${l.at}, ${l.total} worktrees, removed ${l.removed}, ${l.waiting} safe ones waiting for the next run.`);
  lines.push(`Skipped: ${reasons.length ? reasons.join(', ') : 'none'}.`);
  lines.push(`Freed: ${formatBytes(l.bytesFreed)}${l.bytesComplete ? '' : ' or more'}.`);
  return lines;
}
