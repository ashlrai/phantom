/**
 * `phm worktrees`: one row per job worktree with a plain state and a
 * safe-to-remove verdict, plus `--reap` to remove the safe ones.
 *
 * Evidence comes from the existing worktree audit (`readWtAudit`); this module
 * only folds its fine-grained states into six plain ones and adds the removal
 * gates. A row is safe to remove only when all of these hold:
 *   - the job's PR merged, or the job finished with an empty result;
 *   - the audit found nothing protecting it (no live job, no keep list, keep.txt
 *     or pin entry, every safety source readable);
 *   - its newest evidence is at least six hours old;
 *   - `git status` shows no modified or untracked files.
 * Removal is plain `git worktree remove` without --force, so Git itself
 * refuses a tree that changed after the check. Readers, the clean check, the
 * remover and the removal log are injectable so tests never touch real repos.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { measureWorktreeBytes, type WorktreeMeasurement } from '../worktree-retention.js';
import { readWtAudit, type WtAuditDeps, type WtAuditEntry, type WtAuditState } from './wt-audit.js';

export const WORKTREES_SAFE_AGE_HOURS = 6;
/** Fleet warning level for job worktrees on one host. */
export const WORKTREES_WARN_AT = 40;
/** Safe worktrees with no reaper run for this long mean the reaper is stale. */
export const REAPER_STALE_HOURS = 24;
/** A publisher/reaper marker older than this with no finish is a stuck run. */
export const STUCK_RUN_HOURS = 6;
const REAP_LOG_TAIL_BYTES = 64 * 1024;
const REAP_BATCH_MS = 10 * 60_000;
const CLEAN_CHECK_BUDGET_MS = 60_000;
const MEASURE_BUDGET_MS = 20_000;
const CLEAN_CHECK_CONCURRENCY = 4;

export type WorktreeState = 'live' | 'merged' | 'empty' | 'open' | 'kept' | 'unknown';
export const WORKTREE_STATES: readonly WorktreeState[] = ['live', 'merged', 'empty', 'open', 'kept', 'unknown'];

/** Why a row is not safe to remove; null when it is safe. */
export type WorktreeHold =
  | 'live-job' | 'open-pr' | 'kept' | 'state-unknown' | 'records-unreadable'
  | 'too-new' | 'uncommitted-changes' | 'not-checked';

export interface WorktreeRow {
  job: string;
  repo: string | null;
  state: WorktreeState;
  /** Hours since the newest evidence (ledger row, run files, folder mtime). */
  ageHours: number | null;
  /** Measured only for safe rows; null elsewhere. */
  bytes: number | null;
  /** null when Git was not asked: the row failed an earlier gate. */
  clean: boolean | null;
  safe: boolean;
  hold: WorktreeHold | null;
}

export interface WorktreeRemoval {
  job: string;
  status: 'removed' | 'refused' | 'failed';
  reason?: 'state-changed' | 'uncommitted-changes' | 'unsafe-path' | 'git-remove-failed';
}

export type ReaperReason =
  | 'nothing-to-reap' | 'ran-recently' | 'never-ran' | 'last-run-old' | 'last-run-failed'
  | 'stuck-run' | 'sources-unreadable' | 'log-unreadable';

/** Read-only reaper diagnostics: is removal keeping up with what is eligible? */
export interface ReaperHealth {
  /** healthy: nothing waits or the reaper ran lately; stale: eligible work is waiting on a reaper that is not running; unknown: evidence unreadable. */
  state: 'healthy' | 'stale' | 'unknown';
  reason: ReaperReason;
  /** Newest removal attempt in queue/worktree-reap.jsonl; null when none. */
  lastRunAt: string | null;
  lastRunAgeHours: number | null;
  /** Outcomes of the newest batch of attempts (those within 10 minutes of the last one). */
  lastRun: { removed: number; refused: number; failed: number } | null;
  /** Safe-to-remove jobs (merged or empty, clean, old enough, unprotected). Never includes live, open, kept or dirty ones. */
  eligible: string[];
  /** Jobs whose publisher/reaper marker is older than 6 hours: diagnosed, never removed. */
  stuckRuns: string[];
  /** One plain next step, or null when nothing is needed. */
  next: string | null;
}

export interface WorktreesReport {
  schema: 'worktrees.v1';
  generatedAt: string;
  /** false when a safety source could not be read; nothing is then safe. */
  sourcesOk: boolean;
  warnAt: number;
  counts: Record<WorktreeState, number> & { total: number; safe: number };
  reclaimableBytes: number;
  /** false when a size scan timed out: reclaimableBytes is then a floor. */
  reclaimableComplete: boolean;
  mode: 'list' | 'dry-run' | 'apply';
  rows: WorktreeRow[];
  reaper: ReaperHealth;
  removals?: WorktreeRemoval[];
}

export interface WorktreesDeps extends Pick<WtAuditDeps, 'fs' | 'readJobs' | 'ps' | 'readPins'> {
  now?: number;
  wtRoot?: string;
  runsRoot?: string;
  /** Injected audit; default is readWtAudit over the deps above. */
  audit?: typeof readWtAudit;
  /** true/false from `git status`; null when it could not be read. */
  isClean?: (path: string) => Promise<boolean | null>;
  measure?: (path: string) => WorktreeMeasurement | Promise<WorktreeMeasurement>;
  /** Reaper removal log; 'missing' when it was never written, 'unreadable' on any other failure. */
  readReapLog?: (runsRoot: string) => Promise<{ state: 'ok' | 'missing' | 'unreadable'; text: string }>;
  /** Removes one worktree with `git worktree remove` (never --force). */
  remove?: (path: string, wtRoot: string) => Promise<void>;
  /** Records one removal attempt; default appends to queue/worktree-reap.jsonl. */
  logRemoval?: (entry: WorktreeRemoval & { at: string }) => Promise<void>;
}

const STATE_OF: Record<WtAuditState, WorktreeState | null> = {
  running: 'live', reaping: 'live', publishing: 'live',
  merged: 'merged', empty: 'empty', open: 'open', published: 'open',
  held: 'kept', archived: 'kept',
  ended: 'unknown', finished: 'unknown', recorded: 'unknown', orphaned: 'unknown', unknown: 'unknown', invalid: 'unknown',
  // Hidden folders and lane guardians are not job worktrees.
  excluded: null,
};

const HOLD_OF_STATE: Partial<Record<WorktreeState, WorktreeHold>> = {
  live: 'live-job', open: 'open-pr', kept: 'kept', unknown: 'state-unknown',
};

/** Gates that need no Git call: state, audit blockers, age. */
function preHold(entry: WtAuditEntry, state: WorktreeState): WorktreeHold | null {
  const byState = HOLD_OF_STATE[state];
  if (byState) return byState;
  if (!entry.reapable) return entry.blockers.includes('fresh') ? 'too-new' : 'records-unreadable';
  if (entry.ageHours === null || entry.ageHours < WORKTREES_SAFE_AGE_HOURS) return 'too-new';
  return null;
}

const run = promisify(execFile);

/** Modified or untracked files count; ignored build output (node_modules,
 * dist) does not, matching what `git worktree remove` itself refuses on. */
async function defaultIsClean(path: string): Promise<boolean | null> {
  try {
    const { stdout } = await run('git', ['-C', path, 'status', '--porcelain', '--untracked-files=normal'],
      { timeout: 15_000, maxBuffer: 1024 * 1024 });
    return stdout.length === 0;
  } catch { return null; }
}

async function defaultRemove(path: string, wtRoot: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(path)) !== await realpath(wtRoot)) {
    throw Object.assign(new Error('unsafe path'), { unsafePath: true });
  }
  await run('git', ['-C', path, 'worktree', 'remove', '--', path], { timeout: 60_000, maxBuffer: 64 * 1024 });
}

async function defaultReadReapLog(runsRoot: string): ReturnType<NonNullable<WorktreesDeps['readReapLog']>> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(join(runsRoot, 'queue', 'worktree-reap.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile()) return { state: 'unreadable', text: '' };
    const length = Math.min(info.size, REAP_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, info.size - length);
    return { state: 'ok', text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', text: '' };
  } finally { await file?.close().catch(() => undefined); }
}

/** Newest removal batch from the log tail; skips a cut first line and bad rows. */
export function parseReapLog(text: string): { lastAt: number; lastRun: NonNullable<ReaperHealth['lastRun']> } | null {
  const rows: Array<{ at: number; status: string }> = [];
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line) as { at?: unknown; status?: unknown };
      const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
      if (Number.isFinite(at) && typeof row.status === 'string') rows.push({ at, status: row.status });
    } catch { /* blank, partial or foreign line */ }
  }
  if (rows.length === 0) return null;
  const lastAt = Math.max(...rows.map(r => r.at));
  const lastRun = { removed: 0, refused: 0, failed: 0 };
  for (const r of rows) {
    if (lastAt - r.at <= REAP_BATCH_MS && (r.status === 'removed' || r.status === 'refused' || r.status === 'failed')) lastRun[r.status]++;
  }
  return { lastAt, lastRun };
}

/** Pure verdict from evidence. A healthy run (recent attempt, or nothing waiting) never reads as stale. */
export function assessReaper(input: {
  now: number; sourcesOk: boolean; eligible: string[]; stuckRuns: string[];
  log: { state: 'ok' | 'missing' | 'unreadable'; text: string };
}): ReaperHealth {
  const { now, eligible, stuckRuns } = input;
  const parsed = input.log.state === 'ok' ? parseReapLog(input.log.text) : null;
  const lastRunAgeHours = parsed ? Math.max(0, Math.round(((now - parsed.lastAt) / 3_600_000) * 10) / 10) : null;
  const apply = '`phm worktrees --reap --apply`';
  const make = (state: ReaperHealth['state'], reason: ReaperReason, next: string | null): ReaperHealth => ({
    state, reason,
    lastRunAt: parsed ? new Date(parsed.lastAt).toISOString() : null,
    lastRunAgeHours, lastRun: parsed?.lastRun ?? null, eligible, stuckRuns, next,
  });
  if (!input.sourcesOk) return make('unknown', 'sources-unreadable', 'Fix the unreadable records first; nothing is marked safe until they read.');
  if (stuckRuns.length) return make('stale', 'stuck-run', `Check ${stuckRuns.join(', ')}: the publisher marker is over ${STUCK_RUN_HOURS} hours old. It is never removed automatically.`);
  if (eligible.length === 0) return make('healthy', 'nothing-to-reap', null);
  if (input.log.state === 'unreadable') return make('unknown', 'log-unreadable', 'The reap log could not be read; run ' + apply + ' to reap now.');
  if (!parsed) return make('stale', 'never-ran', `${eligible.length} safe to remove and the reaper has never run. Run ${apply}.`);
  if (lastRunAgeHours! >= REAPER_STALE_HOURS) return make('stale', 'last-run-old', `${eligible.length} safe to remove and the reaper last ran ${Math.round(lastRunAgeHours!)} hours ago. Run ${apply}.`);
  if (parsed.lastRun.removed === 0 && parsed.lastRun.failed > 0) return make('stale', 'last-run-failed', `The last reaper run removed nothing and ${parsed.lastRun.failed} failed. Check git, then run ${apply}.`);
  return make('healthy', 'ran-recently', null);
}

const defaultRunsRoot = (): string => process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
const defaultWtRoot = (): string => process.env['ASHLR_WT_DIR'] ?? join(homedir(), 'Projects', 'ashlrai', 'wt');

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/** Read every job worktree; with mode 'apply', remove the safe ones. */
export async function readWorktrees(mode: WorktreesReport['mode'] = 'list', deps: WorktreesDeps = {}): Promise<WorktreesReport> {
  const now = deps.now ?? Date.now();
  const wtRoot = deps.wtRoot ?? defaultWtRoot();
  const runsRoot = deps.runsRoot ?? defaultRunsRoot();
  const readAudit = () => (deps.audit ?? readWtAudit)({
    now, wtRoot, runsRoot, wantSize: false,
    ...(deps.fs ? { fs: deps.fs } : {}), ...(deps.readJobs ? { readJobs: deps.readJobs } : {}),
    ...(deps.ps ? { ps: deps.ps } : {}), ...(deps.readPins ? { readPins: deps.readPins } : {}),
  });
  const audit = await readAudit();
  const rows = rowsOf(audit.worktrees);

  // Git and size scans run only for rows that passed every cheaper gate.
  const isClean = deps.isClean ?? defaultIsClean;
  const cleanDeadline = Date.now() + CLEAN_CHECK_BUDGET_MS;
  await pool(rows.filter(row => row.hold === null), CLEAN_CHECK_CONCURRENCY, async row => {
    row.clean = Date.now() < cleanDeadline ? await isClean(join(wtRoot, row.job)).catch(() => null) : null;
    row.hold = row.clean === true ? null : row.clean === false ? 'uncommitted-changes' : 'not-checked';
    row.safe = row.hold === null;
  });
  const measureDeadline = Date.now() + MEASURE_BUDGET_MS;
  const measure = deps.measure ?? ((path: string) => measureWorktreeBytes(path, { deadlineMs: measureDeadline }));
  let reclaimableBytes = 0;
  let reclaimableComplete = true;
  for (const row of rows.filter(r => r.safe)) {
    const size = await Promise.resolve().then(() => measure(join(wtRoot, row.job))).catch(() => ({ bytes: 0, complete: false }));
    row.bytes = size.bytes;
    reclaimableBytes += size.bytes;
    reclaimableComplete &&= size.complete;
  }

  const counts = { total: rows.length, safe: 0, live: 0, merged: 0, empty: 0, open: 0, kept: 0, unknown: 0 };
  for (const row of rows) { counts[row.state]++; if (row.safe) counts.safe++; }
  const s = audit.sources;
  const sourcesOk = s.worktrees === 'healthy' && s.runs === 'healthy' && s.jobs === 'healthy' && s.ps === 'healthy'
    && s.pins === 'valid' && ![s.queue, s.keep, s.run, s.status].includes('degraded');
  const stuckRuns = audit.worktrees
    .filter(e => (e.state === 'reaping' || e.state === 'publishing') && e.ageHours !== null && e.ageHours >= STUCK_RUN_HOURS)
    .map(e => e.name).sort();
  const reaper = assessReaper({
    now, sourcesOk, stuckRuns, eligible: rows.filter(r => r.safe).map(r => r.job),
    log: await (deps.readReapLog ?? defaultReadReapLog)(runsRoot).catch(() => ({ state: 'unreadable' as const, text: '' })),
  });
  const report: WorktreesReport = {
    schema: 'worktrees.v1',
    generatedAt: new Date(now).toISOString(),
    sourcesOk,
    warnAt: WORKTREES_WARN_AT,
    counts,
    reclaimableBytes,
    reclaimableComplete,
    mode,
    rows,
    reaper,
  };
  if (mode === 'apply') {
    // Git checks can take a while; a job relaunched or kept since then must win.
    const fresh = new Map(rowsOf((await readAudit()).worktrees).map(row => [row.job, row]));
    report.removals = await removeSafe(rows, fresh, wtRoot, runsRoot, isClean, deps);
  }
  return report;
}

function rowsOf(entries: readonly WtAuditEntry[]): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  for (const entry of entries) {
    const state = STATE_OF[entry.state];
    if (state === null) continue;
    rows.push({ job: entry.name, repo: entry.repo, state, ageHours: entry.ageHours, bytes: null, clean: null, safe: false, hold: preHold(entry, state) });
  }
  return rows.sort((a, b) => a.job.localeCompare(b.job));
}

async function removeSafe(
  rows: WorktreeRow[], fresh: ReadonlyMap<string, WorktreeRow>, wtRoot: string, runsRoot: string,
  isClean: NonNullable<WorktreesDeps['isClean']>, deps: WorktreesDeps,
): Promise<WorktreeRemoval[]> {
  const remove = deps.remove ?? defaultRemove;
  const log = deps.logRemoval ?? (async (entry: WorktreeRemoval & { at: string }) => {
    const file = join(runsRoot, 'queue', 'worktree-reap.jsonl');
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  });
  const removals: WorktreeRemoval[] = [];
  for (const row of rows.filter(r => r.safe)) {
    const path = join(wtRoot, row.job);
    let removal: WorktreeRemoval;
    const latest = fresh.get(row.job);
    if (latest?.state !== row.state || latest.hold !== null) removal = { job: row.job, status: 'refused', reason: 'state-changed' };
    // Re-check right before removal: work may have landed since the read.
    else if (await isClean(path).catch(() => null) !== true) removal = { job: row.job, status: 'refused', reason: 'uncommitted-changes' };
    else {
      try { await remove(path, wtRoot); removal = { job: row.job, status: 'removed' }; }
      catch (error) {
        // Git output can name private files, so only a fixed reason is kept.
        removal = (error as { unsafePath?: boolean }).unsafePath
          ? { job: row.job, status: 'refused', reason: 'unsafe-path' }
          : { job: row.job, status: 'failed', reason: 'git-remove-failed' };
      }
    }
    removals.push(removal);
    await log({ ...removal, at: new Date().toISOString() }).catch(() => undefined);
  }
  return removals;
}

/* Human formatting, pure. */

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : '0 KB';
}

export const STATE_WORDS: Record<WorktreeState, string> = {
  live: 'live job', merged: 'merged PR', empty: 'empty result', open: 'open PR', kept: 'kept on purpose', unknown: 'unknown',
};
const HOLD_WORDS: Record<WorktreeHold, string> = {
  'live-job': 'job is running', 'open-pr': 'PR is open', kept: 'kept on purpose', 'state-unknown': 'state unknown',
  'records-unreadable': 'records unreadable', 'too-new': 'under 6 hours old',
  'uncommitted-changes': 'has uncommitted changes', 'not-checked': 'could not check for changes',
};

export function formatWorktrees(report: WorktreesReport): string[] {
  const shown = report.mode === 'list' ? report.rows : report.rows.filter(row => row.safe);
  const lines: string[] = [];
  if (report.counts.total === 0) lines.push('No job worktrees.');
  else if (shown.length) {
    lines.push(['JOB', 'REPO', 'STATE', 'AGE', 'SIZE', 'SAFE TO REMOVE'].join('\t'));
    for (const row of shown) {
      lines.push([row.job, row.repo ?? '-', STATE_WORDS[row.state],
        row.ageHours === null ? '-' : `${Math.round(row.ageHours)} h`,
        row.bytes === null ? '-' : formatBytes(row.bytes),
        row.safe ? 'yes' : `no, ${HOLD_WORDS[row.hold!]}`].join('\t'));
    }
  }
  const c = report.counts;
  if (c.total) {
    lines.push(`${c.total} job worktrees (warning at ${report.warnAt}): ${WORKTREE_STATES.filter(s => c[s]).map(s => `${c[s]} ${STATE_WORDS[s]}`).join(', ')}.`);
  }
  lines.push(`Safe to remove: ${c.safe} (${formatBytes(report.reclaimableBytes)}${report.reclaimableComplete ? '' : ' or more'}).`);
  const r = report.reaper;
  const last = r.lastRunAt === null ? 'never ran' : `last ran ${Math.round(r.lastRunAgeHours!)} h ago`;
  if (r.reason !== 'nothing-to-reap') lines.push(`Reaper: ${r.state} (${last}).`);
  if (r.next) lines.push(r.next);
  if (!report.sourcesOk) lines.push('Some records could not be read, so nothing is marked safe to remove.');
  for (const removal of report.removals ?? []) {
    lines.push(`${removal.job}: ${removal.status}${removal.reason ? ` (${removal.reason.replace(/-/g, ' ')})` : ''}.`);
  }
  if (report.mode === 'dry-run') lines.push(c.safe ? 'Dry run: nothing was removed. Run phm worktrees --reap --apply to remove them.' : 'Dry run: nothing was removed.');
  else if (report.mode === 'list' && c.safe) lines.push('Run phm worktrees --reap to preview removal.');
  return lines;
}
