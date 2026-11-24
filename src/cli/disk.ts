/**
 * `phm disk` — read-only disk report for agent worktrees.
 *
 * One answer to "where did the disk go": every job worktree under
 * ~/Projects/ashlrai/wt and every run worktree under ~/.ashlr-runs/wt with
 * its measured size, its lifecycle state from metrics/jobs.jsonl and a plain
 * safe-to-clean-up verdict, plus the quarantine and leftover temp folders
 * that also hold bytes, and the volume's free space.
 *
 * Nothing here deletes, moves or writes. A worktree is marked safe to clean
 * up only when the job's latest ledger outcome is MERGED (or the run
 * finished empty), the finish is over an hour old, and the path is not
 * pinned in ~/.ashlr/kept-worktrees.json. An unreadable ledger keeps every
 * state "unknown" and an unreadable pin file keeps every worktree —
 * unknowns never count as reclaimable. Sizes are logical bytes from the
 * bounded scanner in core/worktree-retention: symlinks are not followed and
 * a timed-out scan reports partial bytes with complete=false, never a fake
 * exact total.
 */
import { execFile } from 'node:child_process';
import { readdirSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { buildDiskPlanReport, formatDiskPlan, type DiskPlanReportV1, type WorktreeRecord, type WorktreeResult } from '../core/disk-maint/removal-plan.js';
import { ledgerPhase } from '../core/fleet/empty-cause.js';
import { ledgerEventTs, ledgerJobId, ledgerLifecycleEvent, ledgerOutcomeState } from '../core/fleet/jobs-ledger-dialect.js';
import { HOST_DISK_FLOOR_GB, diskTrend, type HostDiskTrend } from '../core/fleet/host-top-view.js';
import { readDiskSamples } from '../core/fleet/host-top.js';
import { readSource, type Source } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import {
  isKeptWorktree, measureWorktreeBytes, readKeptWorktrees,
  type KeptWorktrees, type WorktreeMeasurement,
} from '../core/worktree-retention.js';

export const DISK_MAX_JOBS_BYTES = 8 * 1024 * 1024;
export const DISK_REAPABLE_AGE_HOURS = 1;
/** Names inbox merge/apply gives throwaway worktrees under ~/.ashlr/tmp. */
const TEMP_WORKTREE_NAME = /^(vwt|mwt|mergewt|wt)-[0-9a-f]+$/;
/** Hidden folders, lane guardians and separator-bearing names are never job worktrees. */
const SKIP_DIR = (name: string): boolean =>
  name.startsWith('.') || name.startsWith('guardian-') || name === '..' ||
  name.includes('/') || name.includes('\\');
const USAGE = 'usage: phm disk [--plan] [--min-age-hours <n>] [--wt-dir <abs>] [--runs-dir <abs>] [--tmp-dir <abs>] [--json]';

type Output = { log: (message: string) => void; error: (message: string) => void };
type JobsSource = { state: Source; text: string };

export interface DiskDeps {
  now?: number;
  wtRoot?: string;
  runsRoot?: string;
  tmpRoot?: string;
  output?: Output;
  /** Injected directory lister: names of direct subdirectories only. */
  listDirs?: (path: string) => string[] | Promise<string[]>;
  /** Injected reader for metrics/jobs.jsonl; default reads a bounded tail. */
  readJobs?: (path: string) => JobsSource | Promise<JobsSource>;
  /** Injected size scan; default is the bounded logical-byte measurer. */
  measure?: (dir: string) => WorktreeMeasurement | Promise<WorktreeMeasurement>;
  /** Injected kept-worktree policy read; default reads ~/.ashlr/kept-worktrees.json. */
  readPins?: () => KeptWorktrees | Promise<KeptWorktrees>;
  /** Injected pin check; default is isKeptWorktree under the read policy. */
  kept?: (dir: string) => boolean;
  /** Injected free-space probe; default statfs on the worktree root. */
  freeBytes?: (path: string) => number | null | Promise<number | null>;
}

export type WorktreeState = 'merged' | 'empty' | 'open' | 'none' | 'unknown';
export interface DiskEntry {
  name: string;
  bytes: number;
  /** false when the size scan bounded out: bytes is then a partial floor. */
  complete: boolean;
  state: WorktreeState;
  /** The ledger's own outcome word, lowercased; null when there is no record or the ledger is unread. */
  ledgerState: string | null;
  /** Hours since the job's last finish row; null when unprovable. */
  ageHours: number | null;
  /** Pinned in kept-worktrees.json, or kept because the pin file was unreadable. */
  kept: boolean;
  reclaimable: boolean;
}
export interface DiskArea { bytes: number; dirs: number; complete: boolean }
export interface DiskReportV1 {
  schema: 'disk.v1';
  generatedAt: string;
  roots: { worktrees: string; runsWorktrees: string; quarantine: string; temp: string };
  jobsSource: Source;
  /** false means the pin file could not be trusted, so every worktree stayed kept. */
  pinsValid: boolean;
  /** Free bytes on the volume holding the worktree root; null when unmeasured. */
  freeBytes: number | null;
  worktrees: DiskEntry[] | null;
  runsWorktrees: DiskEntry[] | null;
  /** Publish-leftover quarantine: kept on purpose, removed only by hand. */
  quarantine: DiskArea | null;
  /** Crash-leftover inbox worktrees the daemon reaps itself. */
  temp: DiskArea | null;
  totals: {
    worktrees: number;
    bytes: number;
    /** false when any measured folder timed out or read incompletely. */
    complete: boolean;
    reclaimable: number;
    reclaimableBytes: number;
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const HOUR_MS = 3_600_000;

/**
 * Latest outcome and finish rows after the last launch per job id, read in the
 * jobs-ledger dialect (job|job_id|jobId|id, event|type|kind, phase aliases,
 * timestamp aliases and eventless reconciler rows). The last resolved outcome
 * wins — a phase-less outcome row records nothing rather than overwriting a
 * merge — and finish.empty marks an empty run. Publish claims and other
 * operational rows are not lifecycle rows. Torn lines are skipped, never
 * echoed.
 */
export function parseJobLedger(
  text: string,
): Map<string, { state: string | null; finishMs: number | null; finishEmpty: boolean }> {
  const latest = new Map<string, { outcome?: string; finishMs: number | null; finishEmpty: boolean }>();
  for (const line of text.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line) as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const id = ledgerJobId(row);
      if (id === null) continue;
      const phase = ledgerPhase(row);
      const event = ledgerLifecycleEvent(row, phase);
      if (event === 'launch') { latest.delete(id); continue; }
      const state = ledgerOutcomeState(row, event, phase);
      if (event !== 'finish' && state === null) continue;
      const entry = latest.get(id) ?? { finishMs: null, finishEmpty: false };
      if (event === 'finish') {
        entry.finishMs = ledgerEventTs(row, phase);
        entry.finishEmpty = row['empty'] === true;
      }
      if (state !== null) entry.outcome = state.toLowerCase();
      latest.set(id, entry);
    } catch { /* skip damaged rows; never echo their contents */ }
  }
  const records = new Map<string, { state: string | null; finishMs: number | null; finishEmpty: boolean }>();
  for (const [id, entry] of latest) {
    records.set(id, {
      state: entry.outcome ?? null,
      finishMs: entry.finishMs,
      finishEmpty: entry.finishEmpty,
    });
  }
  return records;
}

/** Same lifecycle words as `ashlr fleet wt-reap`: merged, empty, open, none. */
export function classifyWorktree(
  record: { state: string | null; finishEmpty: boolean } | undefined,
): Exclude<WorktreeState, 'unknown'> {
  if (record?.state === 'merged') return 'merged';
  if (record?.state === 'open') return 'open';
  if (record && record.state === null && record.finishEmpty) return 'empty';
  return 'none';
}

const defaultListDirs = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);

/** Free bytes on the volume holding path, walking to its nearest existing ancestor. */
const defaultFreeBytes = (path: string): number | null => {
  let current = resolve(path);
  for (;;) {
    try {
      const stat = statfsSync(current);
      if (stat.bsize <= 0 || stat.bavail < 0) return null;
      return stat.bavail * stat.bsize;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) return null;
      current = dirname(current);
    }
  }
};

export async function readDiskReport(deps: DiskDeps = {}): Promise<DiskReportV1> {
  const nowMs = deps.now ?? Date.now();
  const wtRoot = deps.wtRoot ?? join(homedir(), 'Projects', 'ashlrai', 'wt');
  const runsRoot = deps.runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const tmpRoot = deps.tmpRoot ?? join(homedir(), '.ashlr', 'tmp');
  const listDirs = deps.listDirs ?? defaultListDirs;
  // One shared measurement budget across every folder: a huge tree degrades
  // to partial sizes (complete=false), never an unbounded report.
  const measureDeadline = Date.now() + 20_000;
  const measure = deps.measure ??
    (async (dir: string) => measureWorktreeBytes(dir, { deadlineMs: measureDeadline }));

  let jobs: JobsSource;
  try {
    jobs = await (deps.readJobs ?? ((path: string) => readSource(path, DISK_MAX_JOBS_BYTES, true)))(
      join(runsRoot, 'metrics', 'jobs.jsonl'),
    );
  } catch {
    jobs = { state: 'degraded', text: '' };
  }
  // A ledger that could not be read means "unknown", not "no record": merged
  // work must never masquerade as reclaimable on a guess.
  const ledger = jobs.state === 'healthy' ? parseJobLedger(jobs.text) : null;

  let pins: KeptWorktrees;
  try {
    pins = await (deps.readPins ?? readKeptWorktrees)();
  } catch {
    pins = { paths: [], valid: false };
  }
  const kept = deps.kept ?? ((dir: string) => isKeptWorktree(dir, pins));

  const scan = async (root: string): Promise<DiskEntry[] | null> => {
    let names: string[];
    try {
      names = (await listDirs(root)).filter(name => !SKIP_DIR(name));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
    const entries: DiskEntry[] = [];
    for (const name of names) {
      const dir = join(root, name);
      let measured: WorktreeMeasurement;
      try {
        measured = await measure(dir);
      } catch {
        measured = { bytes: 0, complete: false };
      }
      const record = ledger?.get(name);
      const state: WorktreeState = ledger === null ? 'unknown' : classifyWorktree(record);
      const ageHours = record?.finishMs == null ? null
        : Math.max(0, round1((nowMs - record.finishMs) / HOUR_MS));
      const pinned = kept(dir);
      const reclaimable = (state === 'merged' || state === 'empty') &&
        ageHours !== null && ageHours > DISK_REAPABLE_AGE_HOURS && !pinned;
      entries.push({ name, bytes: measured.bytes, complete: measured.complete, state, ledgerState: ledger === null ? null : record?.state ?? null, ageHours, kept: pinned, reclaimable });
    }
    // Biggest first: the folder that frees the most disk reads first.
    entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    return entries;
  };

  /** Counted bytes for an area that is reported, never lifecycle-judged. */
  const summarize = async (root: string, nameFilter?: RegExp): Promise<DiskArea | null> => {
    let names: string[];
    try {
      names = await listDirs(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
      else return null;
    }
    const area: DiskArea = { bytes: 0, dirs: 0, complete: true };
    for (const name of names) {
      if (nameFilter ? !nameFilter.test(name) : SKIP_DIR(name)) continue;
      let measured: WorktreeMeasurement;
      try {
        measured = await measure(join(root, name));
      } catch {
        area.complete = false;
        continue;
      }
      area.bytes += measured.bytes;
      area.complete &&= measured.complete;
      area.dirs++;
    }
    return area;
  };

  let freeBytes: number | null = null;
  try {
    freeBytes = await (deps.freeBytes ?? defaultFreeBytes)(wtRoot);
    if (typeof freeBytes === 'number' && (!Number.isFinite(freeBytes) || freeBytes < 0)) freeBytes = null;
  } catch {
    freeBytes = null;
  }

  const [worktrees, runsWorktrees, quarantine, temp] = await Promise.all([
    scan(wtRoot),
    scan(join(runsRoot, 'wt')),
    summarize(join(runsRoot, 'quarantine')),
    summarize(tmpRoot, TEMP_WORKTREE_NAME),
  ]);

  const all = [...(worktrees ?? []), ...(runsWorktrees ?? [])];
  const reclaimable = all.filter(e => e.reclaimable);
  return {
    schema: 'disk.v1',
    generatedAt: new Date(nowMs).toISOString(),
    roots: {
      worktrees: wtRoot,
      runsWorktrees: join(runsRoot, 'wt'),
      quarantine: join(runsRoot, 'quarantine'),
      temp: tmpRoot,
    },
    jobsSource: jobs.state,
    pinsValid: pins.valid,
    freeBytes,
    worktrees,
    runsWorktrees,
    quarantine,
    temp,
    totals: {
      worktrees: all.length,
      bytes: all.reduce((sum, e) => sum + e.bytes, 0),
      complete: worktrees !== null && runsWorktrees !== null && all.every(e => e.complete) &&
        quarantine !== null && quarantine.complete && temp !== null && temp.complete,
      reclaimable: reclaimable.length,
      reclaimableBytes: reclaimable.reduce((sum, e) => sum + e.bytes, 0),
    },
  };
}

/** Facts git and the file system give about one folder; any that cannot be read stay unknown. */
export interface FolderFacts { modifiedMs: number | null; uncommitted: 'yes' | 'no' | 'unknown'; commitsAhead: number | null }

const git = (dir: string, args: string[]): Promise<string | null> => new Promise(resolveText => {
  try {
    execFile('git', ['-C', dir, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolveText(error ? null : stdout));
  } catch { resolveText(null); }
});

/** Read-only: stat plus `git status` and `git rev-list`. Never writes to the folder. */
export async function inspectFolder(dir: string): Promise<FolderFacts> {
  let modifiedMs: number | null = null;
  try { modifiedMs = statSync(dir).mtimeMs; } catch { /* unknown */ }
  const status = await git(dir, ['status', '--porcelain']);
  let commitsAhead: number | null = null;
  for (const base of ['origin/master', 'origin/main', 'master', 'main']) {
    if (await git(dir, ['rev-parse', '--verify', '--quiet', base]) === null) continue;
    const count = Number((await git(dir, ['rev-list', '--count', `${base}..HEAD`]))?.trim());
    commitsAhead = Number.isSafeInteger(count) && count >= 0 ? count : null;
    break;
  }
  return { modifiedMs, uncommitted: status === null ? 'unknown' : status.trim() === '' ? 'no' : 'yes', commitsAhead };
}

/** The ledger's words as plan results. A word this does not know stays unknown, never guessed. */
export function planResultOf(entry: Pick<DiskEntry, 'state' | 'ledgerState'>): WorktreeResult {
  if (entry.state === 'merged') return 'pr-merged';
  if (entry.state === 'empty') return 'empty';
  if (entry.state === 'open') return 'pr-open';
  const word = entry.ledgerState ?? '';
  if (word === 'closed') return 'pr-closed';
  if (word === 'running') return 'running';
  if (word.includes('abort')) return 'publish-aborted';
  return 'unknown';
}

export interface DiskPlanDeps extends DiskDeps {
  minAgeHours?: number;
  /** Injected per-folder facts; default reads the folder with stat and git. */
  inspect?: (dir: string) => FolderFacts | Promise<FolderFacts>;
  /** Injected free-disk trend; default reads the sampler history plus one live reading. */
  trend?: () => HostDiskTrend | Promise<HostDiskTrend>;
}

/** Where the disk is going and which finished folders are safe to remove. Reads only. */
export async function readDiskPlan(deps: DiskPlanDeps = {}): Promise<DiskPlanReportV1> {
  const nowMs = deps.now ?? Date.now();
  const disk = await readDiskReport(deps);
  const inspect = deps.inspect ?? inspectFolder;
  const gaps: string[] = [];
  if (disk.worktrees === null || disk.runsWorktrees === null) gaps.push('A worktree folder could not be listed, so its jobs are missing here.');
  if (disk.jobsSource !== 'healthy') gaps.push('The jobs ledger could not be read, so every result is unknown.');
  if (!disk.totals.complete) gaps.push('Some sizes are partial or unmeasured.');
  const items = [
    ...(disk.worktrees ?? []).map(entry => ({ entry, dir: join(disk.roots.worktrees, entry.name) })),
    ...(disk.runsWorktrees ?? []).map(entry => ({ entry, dir: join(disk.roots.runsWorktrees, entry.name) })),
  ];
  const records: WorktreeRecord[] = [];
  for (let i = 0; i < items.length; i += 4) {
    records.push(...await Promise.all(items.slice(i, i + 4).map(async ({ entry, dir }): Promise<WorktreeRecord> => {
      let facts: FolderFacts;
      try { facts = await inspect(dir); } catch { facts = { modifiedMs: null, uncommitted: 'unknown', commitsAhead: null }; }
      return {
        jobId: entry.name,
        bytes: entry.complete ? entry.bytes : null,
        modifiedMs: facts.modifiedMs,
        result: planResultOf(entry),
        uncommitted: facts.uncommitted,
        // A pinned folder is never offered: say it is unknown rather than guess the pin away.
        commitsAhead: entry.kept ? null : facts.commitsAhead,
      };
    })));
  }
  let trend: HostDiskTrend;
  try {
    trend = await (deps.trend ?? (async () => diskTrend(
      await readDiskSamples(deps.runsRoot ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs')),
      HOST_DISK_FLOOR_GB, nowMs)))();
  } catch {
    trend = diskTrend([], HOST_DISK_FLOOR_GB, nowMs);
  }
  return buildDiskPlanReport(records, trend, { nowMs, minAgeHours: deps.minAgeHours, gaps });
}

/** Collapse the operator's home to `~` for display; the JSON side uses sanitizePublicJson. */
function displayDir(path: string): string {
  try {
    const home = homedir().replace(/[/\\]+$/, '');
    if (home.length > 1 && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  } catch { /* no resolvable home — print the path as given */ }
  return path;
}

/** Decimal GB like the fleet disk views; a measured 0-byte folder stays "0". */
function formatGb(bytes: number): string {
  const gb = round1(bytes / 1e9);
  return `${gb === 0 && bytes > 0 ? '<0.1' : gb} GB`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function stateWord(state: WorktreeState): string {
  switch (state) {
    case 'merged': return 'merged';
    case 'empty': return 'finished empty';
    case 'open': return 'still open';
    case 'unknown': return 'state unknown';
    default: return 'no finished record';
  }
}

function describeEntry(entry: DiskEntry): string {
  const size = `${formatGb(entry.bytes)}${entry.complete ? '' : ' measured so far'}`;
  const age = entry.ageHours === null ? '' : ` ${entry.ageHours} hours ago`;
  const word = stateWord(entry.state);
  if (entry.kept) return `${entry.name}: ${size} — ${word}${age} — pinned, kept`;
  if (entry.reclaimable) return `${entry.name}: ${size} — ${word}${age} — safe to clean up`;
  switch (entry.state) {
    case 'merged': case 'empty':
      return `${entry.name}: ${size} — ${word}${age} — kept${entry.ageHours === null ? ', age unknown' : ', too new'}`;
    case 'open': return `${entry.name}: ${size} — still open, kept`;
    case 'unknown': return `${entry.name}: ${size} — job record unread, kept`;
    default: return `${entry.name}: ${size} — no finished record, kept`;
  }
}

/** Plain words, one line per fact. Pure — unit-testable without I/O. */
export function formatDiskReport(report: DiskReportV1): string[] {
  const lines: string[] = ['disk report — reads only, deletes nothing'];
  lines.push(`free now: ${report.freeBytes === null ? 'unknown' : formatGb(report.freeBytes)}`);
  if (report.jobsSource !== 'healthy' && report.totals.worktrees > 0) {
    lines.push(`jobs ledger ${report.jobsSource === 'missing' ? 'missing' : 'unreadable'} — every state stays unknown`);
  }
  if (!report.pinsValid) lines.push('pin file unreadable — every worktree kept');

  const section = (title: string, dir: string, entries: DiskEntry[] | null): void => {
    if (entries === null) {
      lines.push(`${title} under ${displayDir(dir)}: unknown (folder unreadable)`);
      return;
    }
    const bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    const lead = entries.some(e => !e.complete) ? 'at least ' : '';
    lines.push(`${title} under ${displayDir(dir)}: ${entries.length === 0 ? 'none'
      : `${lead}${formatGb(bytes)} in ${plural(entries.length, 'folder')}`}`);
    for (const entry of entries) lines.push(`  ${describeEntry(entry)}`);
  };
  section('job worktrees', report.roots.worktrees, report.worktrees);
  section('run worktrees', report.roots.runsWorktrees, report.runsWorktrees);

  lines.push(`quarantine: ${report.quarantine === null || report.quarantine.dirs === 0 ? 'none'
    : `${report.quarantine.complete ? '' : 'at least '}${formatGb(report.quarantine.bytes)} in ${plural(report.quarantine.dirs, 'folder')} — kept on purpose; delete by hand`}`);
  lines.push(`leftover temp worktrees: ${report.temp === null || report.temp.dirs === 0 ? 'none'
    : `${report.temp.complete ? '' : 'at least '}${formatGb(report.temp.bytes)} in ${plural(report.temp.dirs, 'folder')} — the daemon reaps these`}`);

  const { reclaimable, reclaimableBytes } = report.totals;
  if (reclaimable === 0) {
    lines.push('safe to reclaim: nothing found');
  } else {
    lines.push(`safe to reclaim: ${formatGb(reclaimableBytes)} in ${plural(reclaimable, 'worktree')}`);
    const jobSide = (report.worktrees ?? []).some(e => e.reclaimable);
    const runSide = (report.runsWorktrees ?? []).some(e => e.reclaimable);
    if (jobSide) lines.push('  remove them with: ashlr fleet worktree-stale --apply');
    if (runSide) lines.push('  remove them with: ashlr fleet wt-reap --apply');
  }
  return lines;
}

export async function cmdDisk(args: string[], deps: DiskDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output.log('phm disk [--plan] [--min-age-hours <n>] [--wt-dir <abs>] [--runs-dir <abs>] [--tmp-dir <abs>] [--json]\n' +
      'Read-only disk report for agent worktrees: each folder\'s size, its\n' +
      'lifecycle state from the jobs ledger and a plain safe-to-clean-up\n' +
      'verdict, plus quarantine, leftover temp folders and free space.\n' +
      'Merged (or empty-finished) worktrees older than one hour count as\n' +
      'reclaimable unless pinned in ~/.ashlr/kept-worktrees.json. Unread\n' +
      'sources print unknown and keep every worktree. Deletes nothing.\n' +
      '--plan opens with one sentence: free disk, how fast it falls, hours to\n' +
      'the floor and how much finished job folders could free. It lists the\n' +
      'ten largest folders and a removal plan: merged, closed or empty, no\n' +
      'uncommitted changes, nothing ahead of base, not running, older than\n' +
      '--min-age-hours (default 6). Anything with an unknown field is listed\n' +
      'as not sure and kept; folders whose publish aborted after a push are\n' +
      'listed as needing recovery first. The plan only prints; it removes nothing.');
    return 0;
  }
  let json = false;
  let plan = false;
  let minAgeHours: number | undefined;
  let wtRoot = deps.wtRoot;
  let runsRoot = deps.runsRoot;
  let tmpRoot = deps.tmpRoot;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output.error(`error: duplicate option\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--plan') plan = true;
    else if (arg === '--min-age-hours') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 0) { output.error(`error: --min-age-hours needs a number of hours\n${USAGE}`); return 2; }
      minAgeHours = value;
    } else if (arg === '--wt-dir' || arg === '--runs-dir' || arg === '--tmp-dir') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) {
        output.error(`error: ${arg} needs an absolute path\n${USAGE}`);
        return 2;
      }
      if (arg === '--wt-dir') wtRoot = value;
      else if (arg === '--runs-dir') runsRoot = value;
      else tmpRoot = value;
    } else {
      output.error(`error: ${arg.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (minAgeHours !== undefined && !plan) { output.error(`error: --min-age-hours goes with --plan\n${USAGE}`); return 2; }
  if (plan) {
    const report = await readDiskPlan({ ...deps, wtRoot, runsRoot, tmpRoot, minAgeHours });
    if (json) output.log(JSON.stringify(sanitizePublicJson(report)));
    else for (const line of formatDiskPlan(report)) output.log(line);
    return 0;
  }
  const report = await readDiskReport({ ...deps, wtRoot, runsRoot, tmpRoot });
  if (json) output.log(JSON.stringify(sanitizePublicJson(report)));
  else for (const line of formatDiskReport(report)) output.log(line);
  return 0;
}
