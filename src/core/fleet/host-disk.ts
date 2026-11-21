/**
 * `phm host disk`: how fast free disk is falling and when the lanes freeze. Read-only: it never deletes,
 * reaps or stops anything; the fix line only names the command a person or agent can run.
 *
 * Samples are `{at, free_gb}` rows (`at` is epoch seconds). Two sources are merged: the fleet sampler's
 * `queue/disk-growth-history.json` and `queue/host-disk-samples.json`, which each self-tick appends to (at most
 * one row per 5 minutes, 48 hours kept). The burn rate is the fall between the first and last sample in the last
 * 6 hours. The freeze line is `compact.lanes.raise_freeze_below_gb` from the fleet's live config (default 60 GB).
 * Anything not measured is null / "unknown", never zero.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigReader, PINNED_DEFAULTS } from './dynconfig.js';
import { parseDiskHistory, readLiveDiskSample } from './host-top.js';
import type { HostDiskSample } from './host-top-view.js';
import { WORKTREES_PLAN_COMMAND, WORKTREES_SAFE_AGE_HOURS, defaultRunsRoot } from './worktrees.js';
import { readWtAudit, type WtAuditDeps, type WtAuditEntry, type WtAuditReport } from './wt-audit.js';

export const HOST_DISK_SCHEMA = 'host.disk.v1';
export const FREEZE_KEY = 'compact.lanes.raise_freeze_below_gb';
export const BURN_WINDOW_HOURS = 6;
/** Under this many hours left, the digest carries a `disk_low` warning. */
export const DISK_LOW_HOURS = 24;
export const HOST_DISK_SAMPLES_FILE = join('queue', 'host-disk-samples.json');
const SAMPLER_FILE = join('queue', 'disk-growth-history.json');
const MIN_SAMPLE_GAP_S = 5 * 60;
const KEEP_SAMPLES_S = 48 * 3600;
/** The window must span this long before a rate is believed. */
const MIN_SPAN_S = 10 * 60;
const STEADY_GB_PER_HOUR = 0.1;
const LARGEST = 5;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export type HostDiskStatus = 'unknown' | 'steady' | 'falling' | 'below-threshold';

export interface HostDiskFolder { job: string; gb: number; ageHours: number | null; finished: boolean | null }

export interface HostDiskWorktrees {
  /** Job folders on disk; null when the folder list could not be read. */
  folders: number | null;
  finished: number | null;
  /** Finished folders the reaper would take, and the GB they hold (a floor when sizes are incomplete). */
  reapable: number | null;
  reapableGb: number | null;
  sizesComplete: boolean;
  largest: HostDiskFolder[];
}

export interface HostDiskReport {
  schema: typeof HOST_DISK_SCHEMA;
  asOf: string;
  freeGb: number | null;
  status: HostDiskStatus;
  /** GB lost per hour over the last 6 hours; null when unknown, negative when free disk is rising. */
  burnGbPerHour: number | null;
  windowHours: number;
  samples: number;
  /** Where the lanes freeze, in free GB, and which config layer it came from. */
  freezeBelowGb: number;
  freezeSource: string;
  /** Hours until free disk reaches the freeze line: 0 when already below, null when unknown or not falling. */
  hoursToFreeze: number | null;
  /** `disk_low` when under 24 hours remain or free disk is already below the freeze line. */
  warning: 'disk_low' | null;
  worktrees: HostDiskWorktrees;
  /** One plain sentence: what to run. */
  fix: string;
  /** The samples the rate used; present only with --history. */
  history?: Array<{ at: string; freeGb: number }>;
  gaps: string[];
}

// ── samples ──────────────────────────────────────────────────────────────────────────────────────────────

function readRows(path: string): HostDiskSample[] {
  try { return parseDiskHistory(readFileSync(path, 'utf8')); } catch { return []; }
}

/** Sampler rows plus this module's own rows, one per timestamp, oldest first. Junk and future rows are dropped. */
export function readDiskSampleRows(runsDir: string, nowMs: number, extra: readonly HostDiskSample[] = []): HostDiskSample[] {
  const byAt = new Map<number, number>();
  for (const { at, freeGb } of [...readRows(join(runsDir, SAMPLER_FILE)), ...readRows(join(runsDir, HOST_DISK_SAMPLES_FILE)), ...extra]) {
    if (at >= 0 && freeGb >= 0 && at * 1000 <= nowMs) byAt.set(at, freeGb);
  }
  return [...byAt].map(([at, freeGb]) => ({ at, freeGb })).sort((a, b) => a.at - b.at);
}

/** Appends one free-disk reading to the self-tick sample file: at most one per 5 minutes, 48 hours kept. Best effort. */
export async function recordDiskSample(runsDir: string, nowMs: number, live: () => Promise<HostDiskSample | null> = readLiveDiskSample): Promise<void> {
  try {
    const path = join(runsDir, HOST_DISK_SAMPLES_FILE);
    const rows = readRows(path);
    const at = Math.floor(nowMs / 1000);
    if (rows.some(row => Math.abs(at - row.at) < MIN_SAMPLE_GAP_S)) return;
    const reading = await live();
    if (!reading) return;
    const next = [...rows, { at, freeGb: Math.round(reading.freeGb * 100) / 100 }].filter(row => row.at >= at - KEEP_SAMPLES_S);
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(next.map(row => ({ at: row.at, free_gb: row.freeGb }))), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch { /* best effort */ }
}

// ── the burn ─────────────────────────────────────────────────────────────────────────────────────────────

export interface DiskBurn {
  freeGb: number | null;
  status: HostDiskStatus;
  burnGbPerHour: number | null;
  samples: number;
  freezeBelowGb: number;
  hoursToFreeze: number | null;
  window: HostDiskSample[];
}

/** Pure: rate from the first to the last sample in the 6-hour window, then hours to the freeze line. */
export function diskBurn(rows: readonly HostDiskSample[], freezeBelowGb: number, nowMs: number): DiskBurn {
  const window = rows.filter(row => row.at * 1000 >= nowMs - BURN_WINDOW_HOURS * 3_600_000 && row.at * 1000 <= nowMs);
  const newest = rows.at(-1);
  const burn: DiskBurn = { freeGb: newest ? round1(newest.freeGb) : null, status: 'unknown', burnGbPerHour: null,
    samples: window.length, freezeBelowGb, hoursToFreeze: null, window };
  if (!newest) return burn;
  const first = window[0], last = window.at(-1);
  if (first && last && last.at - first.at >= MIN_SPAN_S) {
    burn.burnGbPerHour = Math.round((first.freeGb - last.freeGb) * 3600 / (last.at - first.at) * 100) / 100;
  }
  if (newest.freeGb < freezeBelowGb) { burn.status = 'below-threshold'; burn.hoursToFreeze = 0; }
  else if (burn.burnGbPerHour === null) burn.status = 'unknown';
  else if (burn.burnGbPerHour > STEADY_GB_PER_HOUR) {
    burn.status = 'falling';
    burn.hoursToFreeze = round1((newest.freeGb - freezeBelowGb) / burn.burnGbPerHour);
  } else burn.status = 'steady';
  return burn;
}

/** The freeze line from the fleet's layered config; the pinned default when the config cannot be read. */
export async function readFreezeLine(runsDir: string): Promise<{ gb: number; source: string }> {
  try {
    const config = await createConfigReader({ runsDir }).resolve();
    const value = config.values[FREEZE_KEY];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { gb: value, source: config.provenance[FREEZE_KEY]?.layer ?? 'default' };
  } catch { /* fall through */ }
  return { gb: Number(PINNED_DEFAULTS[FREEZE_KEY]), source: 'default' };
}

const hoursWords = (hours: number): string =>
  hours < 1 ? 'under an hour' : `about ${hours < 10 ? round1(hours) : Math.round(hours)} hours`;

/** The `disk_low` line for the hourly digest; null when nothing is wrong or too little is known. */
export function diskLowLine(burn: DiskBurn): string | null {
  if (burn.freeGb === null) return null;
  if (burn.status === 'below-threshold') return `disk_low: ${burn.freeGb} GB free, below the ${burn.freezeBelowGb} GB line where lanes freeze. Run \`phm host disk\`.`;
  if (burn.status !== 'falling' || burn.hoursToFreeze === null || burn.hoursToFreeze >= DISK_LOW_HOURS) return null;
  return `disk_low: ${burn.freeGb} GB free, falling ${burn.burnGbPerHour} GB an hour; lanes freeze at ${burn.freezeBelowGb} GB in ${hoursWords(burn.hoursToFreeze)}. Run \`phm host disk\`.`;
}

/** What the hourly digest reads: recorded samples only, so a digest never touches the disk or the worktrees. */
export async function readDiskLowLine(runsDir: string, nowMs: number): Promise<string | null> {
  const freeze = await readFreezeLine(runsDir);
  return diskLowLine(diskBurn(readDiskSampleRows(runsDir, nowMs), freeze.gb, nowMs));
}

// ── worktrees ────────────────────────────────────────────────────────────────────────────────────────────

const LIVE_STATES = new Set(['running', 'reaping', 'publishing']);
/** Finished, still running, or unknown when the audit could not tell. */
const finishedOf = (state: string): boolean | null =>
  LIVE_STATES.has(state) ? false : ['unknown', 'orphaned', 'invalid'].includes(state) ? null : true;
const gb = (bytes: number): number => round1(bytes / 1e9);

export function summarizeWorktrees(audit: WtAuditReport | null): HostDiskWorktrees {
  if (!audit || audit.sources.worktrees !== 'healthy') {
    return { folders: null, finished: null, reapable: null, reapableGb: null, sizesComplete: false, largest: [] };
  }
  const folders = audit.worktrees.filter((w: WtAuditEntry) => w.state !== 'excluded');
  // The reaper takes merged or empty folders over the safe age; its own clean check can only lower this.
  const take = folders.filter(w => w.reapable && (w.state === 'merged' || w.state === 'empty')
    && w.ageHours !== null && w.ageHours >= WORKTREES_SAFE_AGE_HOURS);
  const largest = folders.filter(w => w.bytes !== null && w.bytes > 0).sort((a, b) => b.bytes! - a.bytes!).slice(0, LARGEST)
    .map(w => ({ job: w.name, gb: gb(w.bytes!), ageHours: w.ageHours === null ? null : round1(w.ageHours), finished: finishedOf(w.state) }));
  return {
    folders: folders.length,
    finished: folders.filter(w => finishedOf(w.state) === true).length,
    reapable: take.length,
    reapableGb: gb(take.reduce((sum, w) => sum + (w.bytes ?? 0), 0)),
    sizesComplete: audit.totals.complete,
    largest,
  };
}

export function fixLine(worktrees: HostDiskWorktrees, status: HostDiskStatus): string {
  if (worktrees.folders === null) return 'Job folders could not be read, so there is no cleanup estimate.';
  const lead = `${worktrees.folders} job folders, ${worktrees.finished ?? 0} of them finished.`;
  if (!worktrees.reapable) return `${lead} None are ready to reap yet.${status === 'falling' || status === 'below-threshold' ? ' Free disk is falling for another reason; check `phm host top`.' : ''}`;
  const size = `${worktrees.sizesComplete ? 'about' : 'at least'} ${worktrees.reapableGb} GB`;
  return `${lead} \`${WORKTREES_PLAN_COMMAND}\` lists the ${worktrees.reapable} ready to remove, freeing ${size}.`;
}

// ── the report ───────────────────────────────────────────────────────────────────────────────────────────

export interface HostDiskDeps extends Pick<WtAuditDeps, 'fs' | 'readJobs' | 'ps' | 'readPins' | 'measure' | 'wtRoot'> {
  now?: number;
  runsDir?: string;
  /** Extra samples (tests inject; production adds one live reading). */
  samples?: readonly HostDiskSample[];
  live?: () => Promise<HostDiskSample | null>;
  /** Injected audit; default is the read-only wt-audit with sizes. */
  audit?: typeof readWtAudit;
  /** Skip the folder scan (the digest and fast callers). */
  skipWorktrees?: boolean;
}

export async function readHostDisk(deps: HostDiskDeps = {}, history = false): Promise<HostDiskReport> {
  const now = deps.now ?? Date.now();
  const runsDir = deps.runsDir ?? defaultRunsRoot();
  const gaps: string[] = [];
  const live = deps.samples ? null : await (deps.live ?? readLiveDiskSample)().catch(() => null);
  const rows = readDiskSampleRows(runsDir, now, [...(deps.samples ?? []), ...(live ? [live] : [])]);
  const freeze = await readFreezeLine(runsDir);
  const burn = diskBurn(rows, freeze.gb, now);
  if (burn.freeGb === null) gaps.push('Free disk is unknown: no samples and no live reading.');
  else if (burn.burnGbPerHour === null) gaps.push(`Burn rate is unknown: needs two samples at least 10 minutes apart in the last ${BURN_WINDOW_HOURS} hours (have ${burn.samples}). Self-ticks add one every 5 minutes.`);

  let audit: WtAuditReport | null = null;
  if (!deps.skipWorktrees) {
    const { fs, readJobs, ps, readPins, measure, wtRoot } = deps;
    audit = await (deps.audit ?? readWtAudit)({ now, runsRoot: runsDir, wantSize: true,
      ...(fs ? { fs } : {}), ...(readJobs ? { readJobs } : {}), ...(ps ? { ps } : {}),
      ...(readPins ? { readPins } : {}), ...(measure ? { measure } : {}), ...(wtRoot ? { wtRoot } : {}) }).catch(() => null);
    if (!audit || audit.sources.worktrees !== 'healthy') gaps.push('Job folders could not be listed.');
    else if (!audit.totals.complete) gaps.push('Folder sizes were not all measured in time, so the largest list and GB estimate are floors.');
  } else gaps.push('Job folders were not scanned.');
  const worktrees = summarizeWorktrees(audit);

  const report: HostDiskReport = {
    schema: HOST_DISK_SCHEMA, asOf: new Date(now).toISOString(), freeGb: burn.freeGb, status: burn.status,
    burnGbPerHour: burn.burnGbPerHour, windowHours: BURN_WINDOW_HOURS, samples: burn.samples,
    freezeBelowGb: freeze.gb, freezeSource: freeze.source, hoursToFreeze: burn.hoursToFreeze,
    warning: diskLowLine(burn) ? 'disk_low' : null, worktrees, fix: fixLine(worktrees, burn.status), gaps,
  };
  if (history) report.history = burn.window.map(row => ({ at: new Date(row.at * 1000).toISOString(), freeGb: round1(row.freeGb) }));
  return report;
}

export function formatHostDisk(report: HostDiskReport): string[] {
  const free = report.freeGb === null ? 'unknown' : `${report.freeGb} GB`;
  const rate = report.burnGbPerHour === null ? 'unknown'
    : report.burnGbPerHour > STEADY_GB_PER_HOUR ? `falling ${report.burnGbPerHour} GB an hour`
      : report.burnGbPerHour < -STEADY_GB_PER_HOUR ? `rising ${Math.abs(report.burnGbPerHour)} GB an hour` : 'holding steady';
  const left = report.status === 'below-threshold' ? 'already below it'
    : report.hoursToFreeze === null ? (report.status === 'steady' ? 'not falling' : 'unknown') : hoursWords(report.hoursToFreeze);
  const lines = [
    ...(report.warning ? [`Warning (disk_low): lanes freeze below ${report.freezeBelowGb} GB free.`] : []),
    `Free disk: ${free}`,
    `Burn, last ${report.windowHours} hours: ${rate} (${report.samples} samples)`,
    `Lanes freeze below ${report.freezeBelowGb} GB (${report.freezeSource} setting): ${left}`,
  ];
  const { largest } = report.worktrees;
  if (largest.length) {
    lines.push('', 'Largest job folders:');
    for (const f of largest) {
      lines.push(`  ${f.job.slice(0, 40).padEnd(40)} ${String(f.gb).padStart(6)} GB  ${f.ageHours === null ? 'age unknown' : `${Math.round(f.ageHours)}h old`}  ${f.finished === null ? 'finished: unknown' : f.finished ? 'finished' : 'running'}`);
    }
  }
  lines.push('', report.fix);
  if (report.history) {
    lines.push('', 'Samples:');
    for (const h of report.history) lines.push(`  ${h.at}  ${h.freeGb} GB`);
  }
  return [...lines, ...report.gaps.map(gap => `Note: ${gap}`)];
}
