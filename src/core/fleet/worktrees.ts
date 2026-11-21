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
 *   - its newest evidence is at least as old as its class allows (two hours for
 *     a merged PR or an empty result, see WORKTREES_SAFE_AGE_HOURS);
 *   - `git status` shows no modified or untracked files.
 * Removal is plain `git worktree remove` without --force, so Git itself
 * refuses a tree that changed after the check. Readers, the clean check, the
 * remover and the removal log are injectable so tests never touch real repos.
 */
import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { measureWorktreeBytes, type WorktreeMeasurement } from '../worktree-retention.js';
import { readWtAudit, type WtAuditDeps, type WtAuditEntry, type WtAuditReport, type WtAuditState } from './wt-audit.js';

/** Hours of quiet before any finished worktree is safe to remove. */
export const WORKTREES_SAFE_AGE_HOURS = 6;
/** The command every warning about the worktree count points to. */
export const WORKTREES_PLAN_COMMAND = 'phm worktrees --reap --plan';
/** Fleet warning level for job worktrees on one host. */
export const WORKTREES_WARN_AT = 40;
const CLEAN_CHECK_BUDGET_MS = 60_000;
const MEASURE_BUDGET_MS = 20_000;
const CLEAN_CHECK_CONCURRENCY = 4;

export type WorktreeState = 'live' | 'merged' | 'closed' | 'empty' | 'open' | 'kept' | 'unknown';
export const WORKTREE_STATES: readonly WorktreeState[] = ['live', 'merged', 'closed', 'empty', 'open', 'kept', 'unknown'];

/** The one plain reason behind each row: why it is safe (empty, merged, closed) or why it waits. */
export type WorktreeReason = 'empty' | 'merged' | 'closed' | 'kept' | 'dirty-no-result' | 'too-new' | 'other';
export const WORKTREE_REASONS: readonly WorktreeReason[] = ['empty', 'merged', 'closed', 'kept', 'dirty-no-result', 'too-new', 'other'];

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
  reason: WorktreeReason;
}

export interface WorktreeRemoval {
  job: string;
  status: 'removed' | 'refused' | 'failed';
  reason?: 'state-changed' | 'uncommitted-changes' | 'unsafe-path' | 'git-remove-failed';
}

export interface WorktreesReport {
  schema: 'worktrees.v1';
  generatedAt: string;
  /** false when a safety source could not be read; nothing is then safe. */
  sourcesOk: boolean;
  warnAt: number;
  counts: Record<WorktreeState, number> & { total: number; safe: number };
  /** Every row counted once under its reason. */
  reasons: Record<WorktreeReason, number>;
  reclaimableBytes: number;
  /** false when a size scan timed out: reclaimableBytes is then a floor. */
  reclaimableComplete: boolean;
  mode: 'list' | 'dry-run' | 'apply';
  rows: WorktreeRow[];
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
  /** true when every commit in the worktree is already in origin/master; null when Git could not tell. */
  isMerged?: (path: string) => Promise<boolean | null>;
  measure?: (path: string) => WorktreeMeasurement | Promise<WorktreeMeasurement>;
  /** Removes one worktree with `git worktree remove` (never --force). */
  remove?: (path: string, wtRoot: string) => Promise<void>;
  /** Records one removal attempt; default appends to queue/worktree-reap.jsonl. */
  logRemoval?: (entry: WorktreeRemoval & { at: string }) => Promise<void>;
  /** Most safe rows to attempt in one apply; the rest wait for the next run. Default: all. */
  maxRemovals?: number;
}

const STATE_OF: Record<WtAuditState, WorktreeState | null> = {
  running: 'live', reaping: 'live', publishing: 'live',
  merged: 'merged', empty: 'empty', open: 'open', published: 'open',
  held: 'kept', archived: 'kept',
  ended: 'unknown', finished: 'unknown', recorded: 'unknown', orphaned: 'unknown', unknown: 'unknown', invalid: 'unknown',
  // Hidden folders and lane guardians are not job worktrees.
  excluded: null,
};

/** Audit states where the job has stopped, so its branch can be checked against origin/master. */
const FINISHED_STATES: ReadonlySet<WtAuditState> = new Set(['merged', 'empty', 'open', 'published', 'ended', 'finished']);

interface Verdict { state: WorktreeState; hold: WorktreeHold | null; reason: WorktreeReason; needsGit: boolean }

/** Gates that need no Git call: live job, kept, unreadable records, age, then the job's own verdict. */
function judge(entry: WtAuditEntry, state: WorktreeState, sourcesOk: boolean): Verdict {
  const no = (hold: WorktreeHold, reason: WorktreeReason = 'other'): Verdict => ({ state, hold, reason, needsGit: false });
  if (state === 'live') return no('live-job');
  if (state === 'kept') return no('kept', 'kept');
  if (!sourcesOk) return no('records-unreadable');
  if (entry.ageHours === null || entry.ageHours < WORKTREES_SAFE_AGE_HOURS) return no('too-new', 'too-new');
  if (state === 'merged' || state === 'empty') return { state, hold: null, reason: state, needsGit: false };
  if (entry.signals.outcome === 'closed') return { state: 'closed', hold: null, reason: 'closed', needsGit: false };
  // No verdict on the PR: only a finished job can be proven landed by Git.
  const finished = FINISHED_STATES.has(entry.state) || entry.signals.rc || entry.signals.publishClass !== null;
  return { state, hold: state === 'open' ? 'open-pr' : 'state-unknown', reason: 'other', needsGit: finished };
}

/** A fresh read with any of these holds means a job relaunched, was kept or went stale since the check. */
const LOST_PROTECTION: ReadonlySet<WorktreeHold | null> = new Set(['live-job', 'kept', 'records-unreadable', 'too-new']);

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

/** Exit 0 from merge-base means HEAD is inside origin/master; exit 1 means it is not. */
async function defaultIsMerged(path: string): Promise<boolean | null> {
  try {
    await run('git', ['-C', path, 'merge-base', '--is-ancestor', 'HEAD', 'origin/master'], { timeout: 15_000, maxBuffer: 64 * 1024 });
    return true;
  } catch (error) { return (error as { code?: unknown }).code === 1 ? false : null; }
}

async function defaultRemove(path: string, wtRoot: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || dirname(await realpath(path)) !== await realpath(wtRoot)) {
    throw Object.assign(new Error('unsafe path'), { unsafePath: true });
  }
  await run('git', ['-C', path, 'worktree', 'remove', '--', path], { timeout: 60_000, maxBuffer: 64 * 1024 });
}

export const defaultRunsRoot = (): string => process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
export const defaultWtRoot = (): string => process.env['ASHLR_WT_DIR'] ?? join(homedir(), 'Projects', 'ashlrai', 'wt');

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
  const { rows, needsGit, hasResult } = rowsOf(audit.worktrees, sourcesOkOf(audit.sources));

  // Git and size scans run only for rows that passed every cheaper gate.
  // A finished job with no verdict on its PR is still safe when Git shows all its commits in origin/master.
  const isMerged = deps.isMerged ?? defaultIsMerged;
  await pool(rows.filter(row => needsGit.has(row.job)), CLEAN_CHECK_CONCURRENCY, async row => {
    if (await isMerged(join(wtRoot, row.job)).catch(() => null) === true) Object.assign(row, { state: 'merged', hold: null, reason: 'merged' });
  });
  const isClean = deps.isClean ?? defaultIsClean;
  const cleanDeadline = Date.now() + CLEAN_CHECK_BUDGET_MS;
  await pool(rows.filter(row => row.hold === null), CLEAN_CHECK_CONCURRENCY, async row => {
    row.clean = Date.now() < cleanDeadline ? await isClean(join(wtRoot, row.job)).catch(() => null) : null;
    row.hold = row.clean === true ? null : row.clean === false ? 'uncommitted-changes' : 'not-checked';
    row.safe = row.hold === null;
    // Changes with no RESULT line may be the only copy of the work.
    if (row.clean === false) row.reason = hasResult.has(row.job) ? 'other' : 'dirty-no-result';
    else if (!row.safe) row.reason = 'other';
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

  const counts = { total: rows.length, safe: 0, live: 0, merged: 0, closed: 0, empty: 0, open: 0, kept: 0, unknown: 0 };
  const reasons = { empty: 0, merged: 0, closed: 0, kept: 0, 'dirty-no-result': 0, 'too-new': 0, other: 0 };
  for (const row of rows) { counts[row.state]++; reasons[row.reason]++; if (row.safe) counts.safe++; }
  const report: WorktreesReport = {
    schema: 'worktrees.v1',
    generatedAt: new Date(now).toISOString(),
    sourcesOk: sourcesOkOf(audit.sources),
    warnAt: WORKTREES_WARN_AT,
    counts,
    reasons,
    reclaimableBytes,
    reclaimableComplete,
    mode,
    rows,
  };
  if (mode === 'apply') {
    // Git checks can take a while; a job relaunched or kept since then must win.
    const fresh = await readAudit();
    const latest = new Map(rowsOf(fresh.worktrees, sourcesOkOf(fresh.sources)).rows.map(row => [row.job, row]));
    report.removals = await removeSafe(rows, latest, wtRoot, runsRoot, isClean, deps, deps.maxRemovals);
  }
  return report;
}

/** How many job worktrees exist: the audit only, no Git or size scans. */
export async function countJobWorktrees(deps: WorktreesDeps = {}): Promise<number> {
  const audit = await (deps.audit ?? readWtAudit)({
    now: deps.now ?? Date.now(), wtRoot: deps.wtRoot ?? defaultWtRoot(), runsRoot: deps.runsRoot ?? defaultRunsRoot(), wantSize: false,
    ...(deps.fs ? { fs: deps.fs } : {}), ...(deps.readJobs ? { readJobs: deps.readJobs } : {}),
    ...(deps.ps ? { ps: deps.ps } : {}), ...(deps.readPins ? { readPins: deps.readPins } : {}),
  });
  return rowsOf(audit.worktrees, true).rows.length;
}

function sourcesOkOf(s: WtAuditReport['sources']): boolean {
  return s.worktrees === 'healthy' && s.runs === 'healthy' && s.jobs === 'healthy' && s.ps === 'healthy'
    && s.pins === 'valid' && ![s.queue, s.keep, s.run, s.status].includes('degraded');
}

function rowsOf(entries: readonly WtAuditEntry[], sourcesOk: boolean) {
  const rows: WorktreeRow[] = [];
  const needsGit = new Set<string>();
  const hasResult = new Set<string>();
  for (const entry of entries) {
    const state = STATE_OF[entry.state];
    if (state === null) continue;
    const verdict = judge(entry, state, sourcesOk);
    if (verdict.needsGit) needsGit.add(entry.name);
    if (entry.signals.publishClass !== null) hasResult.add(entry.name);
    rows.push({ job: entry.name, repo: entry.repo, state: verdict.state, ageHours: entry.ageHours, bytes: null, clean: null, safe: false, hold: verdict.hold, reason: verdict.reason });
  }
  rows.sort((a, b) => a.job.localeCompare(b.job));
  return { rows, needsGit, hasResult };
}

async function removeSafe(
  rows: WorktreeRow[], fresh: ReadonlyMap<string, WorktreeRow>, wtRoot: string, runsRoot: string,
  isClean: NonNullable<WorktreesDeps['isClean']>, deps: WorktreesDeps, maxRemovals = Infinity,
): Promise<WorktreeRemoval[]> {
  const remove = deps.remove ?? defaultRemove;
  const log = deps.logRemoval ?? (async (entry: WorktreeRemoval & { at: string }) => {
    const file = join(runsRoot, 'queue', 'worktree-reap.jsonl');
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  });
  const removals: WorktreeRemoval[] = [];
  for (const row of rows.filter(r => r.safe).slice(0, Math.max(0, maxRemovals))) {
    const path = join(wtRoot, row.job);
    let removal: WorktreeRemoval;
    const latest = fresh.get(row.job);
    if (!latest || LOST_PROTECTION.has(latest.hold)) removal = { job: row.job, status: 'refused', reason: 'state-changed' };
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
  live: 'live job', merged: 'merged', closed: 'closed PR', empty: 'empty result', open: 'open PR', kept: 'kept on purpose', unknown: 'unknown',
};
const HOLD_WORDS: Record<WorktreeHold, string> = {
  'live-job': 'job is running', 'open-pr': 'PR is open', kept: 'kept on purpose', 'state-unknown': 'state unknown',
  'records-unreadable': 'records unreadable', 'too-new': 'too new',
  'uncommitted-changes': 'has uncommitted changes', 'not-checked': 'could not check for changes',
};

function holdWords(row: WorktreeRow): string {
  if (row.hold === 'too-new') return `under ${WORKTREES_SAFE_AGE_HOURS} hours old`;
  return HOLD_WORDS[row.hold!];
}

/** Typed form of `--reap --plan`: the removal commands for the safe rows. */
export interface WorktreesPlan {
  schema: 'worktrees.plan.v1';
  commands: string[];
}

/**
 * The exact removal commands for the safe rows, one per line; never --force.
 * `-C <path>` makes each line runnable from any directory, as the reaper does.
 */
export function worktreeRemoveCommands(report: WorktreesReport, wtRoot: string = defaultWtRoot()): string[] {
  return report.rows.filter(row => row.safe).map(row => {
    const path = shellQuote(join(wtRoot, row.job));
    return `git -C ${path} worktree remove ${path}`;
  });
}

/** Single-quote a path for a POSIX shell unless it is plainly safe. */
function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

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
        row.safe ? 'yes' : `no, ${holdWords(row)}`].join('\t'));
    }
  }
  const c = report.counts;
  if (c.total) {
    lines.push(`${c.total} job worktrees (warning at ${report.warnAt}): ${WORKTREE_STATES.filter(s => c[s]).map(s => `${c[s]} ${STATE_WORDS[s]}`).join(', ')}.`);
    if (c.total > report.warnAt) lines.push(`Over the warning level. Run ${WORKTREES_PLAN_COMMAND} for the removal commands.`);
  }
  lines.push(`Safe to remove: ${c.safe} (${formatBytes(report.reclaimableBytes)}${report.reclaimableComplete ? '' : ' or more'}).`);
  if (!report.sourcesOk) lines.push('Some records could not be read, so nothing is marked safe to remove.');
  for (const removal of report.removals ?? []) {
    lines.push(`${removal.job}: ${removal.status}${removal.reason ? ` (${removal.reason.replace(/-/g, ' ')})` : ''}.`);
  }
  if (report.mode === 'dry-run') lines.push(c.safe ? 'Dry run: nothing was removed. Run phm worktrees --reap --apply to remove them.' : 'Dry run: nothing was removed.');
  else if (report.mode === 'list' && c.safe) lines.push('Run phm worktrees --reap to preview removal.');
  return lines;
}
