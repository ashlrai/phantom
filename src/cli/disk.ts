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
import { readdirSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
const USAGE = 'usage: phm disk [--wt-dir <abs>] [--runs-dir <abs>] [--tmp-dir <abs>] [--json]';

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
 * Latest outcome and finish rows per job id, wt-reap semantics: the last row
 * of each event type wins, outcome.state (or .outcome) lowercased, finish.ts
 * parsed for age, finish.empty for an empty run. Torn lines are skipped,
 * never echoed.
 */
export function parseJobLedger(
  text: string,
): Map<string, { state: string | null; finishMs: number | null; finishEmpty: boolean }> {
  const latest = new Map<string, { outcome?: Record<string, unknown>; finish?: Record<string, unknown> }>();
  for (const line of text.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line) as Record<string, unknown> | null;
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const id = row.job ?? row.job_id ?? row.id;
      if (typeof id !== 'string' || (row.event !== 'outcome' && row.event !== 'finish')) continue;
      const entry = latest.get(id) ?? {};
      entry[row.event] = row;
      latest.set(id, entry);
    } catch { /* skip damaged rows; never echo their contents */ }
  }
  const records = new Map<string, { state: string | null; finishMs: number | null; finishEmpty: boolean }>();
  for (const [id, { outcome, finish }] of latest) {
    const state = outcome ? String(outcome.state ?? outcome.outcome ?? '').toLowerCase() : null;
    const at = typeof finish?.ts === 'string' ? Date.parse(finish.ts) : NaN;
    records.set(id, {
      state: state || null,
      finishMs: Number.isFinite(at) ? at : null,
      finishEmpty: finish?.empty === true,
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
      entries.push({ name, bytes: measured.bytes, complete: measured.complete, state, ageHours, kept: pinned, reclaimable });
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
    output.log('phm disk [--wt-dir <abs>] [--runs-dir <abs>] [--tmp-dir <abs>] [--json]\n' +
      'Read-only disk report for agent worktrees: each folder\'s size, its\n' +
      'lifecycle state from the jobs ledger and a plain safe-to-clean-up\n' +
      'verdict, plus quarantine, leftover temp folders and free space.\n' +
      'Merged (or empty-finished) worktrees older than one hour count as\n' +
      'reclaimable unless pinned in ~/.ashlr/kept-worktrees.json. Unread\n' +
      'sources print unknown and keep every worktree. Deletes nothing.');
    return 0;
  }
  let json = false;
  let wtRoot = deps.wtRoot;
  let runsRoot = deps.runsRoot;
  let tmpRoot = deps.tmpRoot;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output.error(`error: duplicate option\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--wt-dir' || arg === '--runs-dir' || arg === '--tmp-dir') {
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
  const report = await readDiskReport({ ...deps, wtRoot, runsRoot, tmpRoot });
  if (json) output.log(JSON.stringify(sanitizePublicJson(report)));
  else for (const line of formatDiskReport(report)) output.log(line);
  return 0;
}
