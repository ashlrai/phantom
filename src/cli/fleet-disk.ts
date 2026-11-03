/**
 * `ashlr fleet disk` — read-only disk-pressure report for the fleet host.
 *
 * Two facts, two injected readers, no writes:
 *
 *   Trend — LEADER rows in ~/.ashlr-runs/queue/dispatch-events.log carry
 *   `free_gb=N`. The readings inside the last 12 hours give free GB lost per
 *   hour and the hours until only 100 GB remain. The reader is injected
 *   (`readEvents`); the default is the bounded, symlink-refusing tail read
 *   shared with `fleet brains`. An unread log prints `unknown` for every
 *   trend fact — never a guessed zero.
 *
 *   Folders — an injected `du` runner lists the ten largest direct
 *   subdirectories of the runs root (wt, logs, queue and so on). A failed du
 *   prints `unknown` for the folders.
 *
 * The command is a view, never a gate, and exits 0 either way. Read-only: no
 * writes, no network.
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { localTimestamp, readSource, type Source } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const FLEET_DISK_WINDOW_HOURS = 12;
export const FLEET_DISK_TARGET_FREE_GB = 100;
export const FLEET_DISK_TOP_DIRS = 10;
export const FLEET_DISK_MAX_TAIL_BYTES = 5 * 1024 * 1024;
const DU_TIMEOUT_MS = 120_000;
const DU_MAX_BUFFER = 4 * 1024 * 1024;

const USAGE = 'usage: ashlr fleet disk [--runs-dir <abs>] [--json]';

type Output = { log: (message: string) => void; error: (message: string) => void };
type EventsSource = { state: Source; text: string };
export interface FleetDiskDeps {
  now?: number;
  runsRoot?: string;
  output?: Output;
  /** Injected reader for queue/dispatch-events.log; default reads a bounded tail. */
  readEvents?: (path: string) => EventsSource | Promise<EventsSource>;
  /** Injected `du -sk`-style runner over the runs root; returns raw stdout text. */
  du?: (root: string) => string | Promise<string>;
}

export interface FleetDiskSample { at: string; ms: number; freeGb: number }
export interface FleetDiskDir { name: string; gb: number }
export interface FleetDiskV1 {
  schema: 'fleet.disk.v1';
  generatedAt: string;
  runsDir: string;
  windowHours: number;
  targetFreeGb: number;
  /** State of the dispatch-events read; 'missing' or 'degraded' leave trend facts null. */
  source: Source;
  samples: number;
  /** Newest free_gb reading inside the window; null when none. */
  freeGbNow: number | null;
  firstFreeGb: number | null;
  observedHours: number | null;
  /** Free GB lost per hour across the observed span; negative means free space grew. */
  gbPerHour: number | null;
  /** Hours until free space reaches targetFreeGb; 0 when already there, null when not shrinking or unprovable. */
  hoursUntilTargetFreeGb: number | null;
  /** Up to ten largest direct subdirs of runsDir; null when `du` could not run. */
  largestSubdirs: FleetDiskDir[] | null;
}

const EVENT_ROW = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z][A-Z0-9_-]{0,63})(?: (.*))?$/;
const FREE_GB = /\bfree_gb=(\d+(?:\.\d+)?)\b/;
const DU_ROW = /^(\d{1,12})[ \t]+(\S.*)$/;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Every LEADER row inside the window that carries a usable `free_gb=N`,
 * oldest first. Future rows cannot be ordered against now; a later line wins
 * a timestamp tie. Pure — no I/O.
 */
export function parseLeaderFreeGb(text: string, nowMs: number, windowHours = FLEET_DISK_WINDOW_HOURS): FleetDiskSample[] {
  const hours = Number.isFinite(windowHours) ? Math.min(24 * 7, Math.max(1, Math.floor(windowHours))) : FLEET_DISK_WINDOW_HOURS;
  const cutoff = nowMs - hours * 3_600_000;
  const byMs = new Map<number, FleetDiskSample>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const m = EVENT_ROW.exec(line);
    if (!m || m[3] !== 'LEADER') continue;
    const found = FREE_GB.exec(m[4] ?? '');
    if (!found) continue;
    const freeGb = Number(found[1]);
    if (!Number.isFinite(freeGb)) continue;
    const stamp = localTimestamp(`${m[1]} ${m[2]}`);
    if (!Number.isFinite(stamp.ms) || stamp.ms > nowMs || stamp.ms < cutoff) continue;
    byMs.set(stamp.ms, { at: stamp.at, ms: stamp.ms, freeGb });
  }
  return [...byMs.values()].sort((a, b) => a.ms - b.ms);
}

/**
 * Parse `du -sk` output into the largest direct subdirs of root — the root's
 * own total line and deeper descendants are dropped, so a recursive `du -sk`
 * listing is acceptable input too. Pure — no I/O.
 */
export function parseDuSubdirs(text: string, root: string, limit = FLEET_DISK_TOP_DIRS): FleetDiskDir[] {
  const base = root.replace(/[/\\]+$/, '');
  const byName = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = DU_ROW.exec(line);
    if (!m) continue;
    const kb = Number(m[1]);
    const path = m[2]!.trim().replace(/[/\\]+$/, '');
    if (!Number.isSafeInteger(kb) || !path.startsWith(`${base}/`)) continue;
    const name = path.slice(base.length + 1);
    // eslint-disable-next-line no-control-regex -- reject control bytes in untrusted text.
    if (!name || name === '.' || name === '..' || name.includes('/') || /[\x00-\x1f\x7f]/.test(name)) continue;
    byName.set(name, Math.max(kb, byName.get(name) ?? 0));
  }
  return [...byName.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    // du -sk counts 1024-byte blocks; report decimal GB like free_gb.
    .map(([name, kb]) => ({ name, gb: round1(kb * 1024 / 1e9) }));
}

/** Fold samples and the folder list into the report. Pure — no I/O. */
export function buildFleetDisk(opts: {
  runsDir: string;
  nowMs: number;
  source: Source;
  samples: FleetDiskSample[];
  largestSubdirs: FleetDiskDir[] | null;
}): FleetDiskV1 {
  const first = opts.samples[0] ?? null;
  const last = opts.samples.at(-1) ?? null;
  const observedHours = first && last ? (last.ms - first.ms) / 3_600_000 : null;
  const gbPerHour = first && last && observedHours !== null && observedHours > 0
    ? round1((first.freeGb - last.freeGb) / observedHours)
    : null;
  const hoursUntilTargetFreeGb =
    last === null ? null
    : last.freeGb <= FLEET_DISK_TARGET_FREE_GB ? 0
    : gbPerHour !== null && gbPerHour > 0 ? round1((last.freeGb - FLEET_DISK_TARGET_FREE_GB) / gbPerHour)
    : null;
  return {
    schema: 'fleet.disk.v1',
    generatedAt: new Date(opts.nowMs).toISOString(),
    runsDir: opts.runsDir,
    windowHours: FLEET_DISK_WINDOW_HOURS,
    targetFreeGb: FLEET_DISK_TARGET_FREE_GB,
    source: opts.source,
    samples: opts.samples.length,
    freeGbNow: last?.freeGb ?? null,
    firstFreeGb: first?.freeGb ?? null,
    observedHours: observedHours === null ? null : round1(observedHours),
    gbPerHour,
    hoursUntilTargetFreeGb,
    largestSubdirs: opts.largestSubdirs,
  };
}

export const defaultDu = (root: string): string => {
  const opts: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: DU_TIMEOUT_MS,
    maxBuffer: DU_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  // `-d 1` bounds the output to the root and its direct children; BSD du
  // cannot combine it with `-s` and knows no `--`. POSIX du without `-d`
  // lists every descendant — parseDuSubdirs filters to depth 1 either way.
  try {
    return execFileSync('du', ['-k', '-d', '1', root], opts);
  } catch {
    return execFileSync('du', ['-k', root], opts);
  }
};

export async function readFleetDisk(deps: FleetDiskDeps = {}): Promise<FleetDiskV1> {
  const nowMs = deps.now ?? Date.now();
  const runsDir = deps.runsRoot ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const readEvents = deps.readEvents ?? ((path: string) => readSource(path, FLEET_DISK_MAX_TAIL_BYTES, true));
  let events: EventsSource;
  try {
    events = await readEvents(join(runsDir, 'queue', 'dispatch-events.log'));
  } catch {
    events = { state: 'degraded', text: '' };
  }
  const samples = parseLeaderFreeGb(events.text, nowMs);
  let largestSubdirs: FleetDiskDir[] | null = null;
  try {
    largestSubdirs = parseDuSubdirs(await (deps.du ?? defaultDu)(runsDir), runsDir);
  } catch {
    largestSubdirs = null;
  }
  return buildFleetDisk({ runsDir, nowMs, source: events.state, samples, largestSubdirs });
}

/** Collapse the operator's home to `~` for display; the JSON side uses sanitizePublicJson. */
function displayDir(path: string): string {
  try {
    const home = homedir().replace(/[/\\]+$/, '');
    if (home.length > 1 && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  } catch { /* no resolvable home — print the path as given */ }
  return path;
}

/** Plain words, one line per fact. Pure — unit-testable without I/O. */
export function formatFleetDisk(report: FleetDiskV1): string[] {
  const lines: string[] = [];
  lines.push(`disk free now: ${report.freeGbNow === null ? 'unknown' : `${report.freeGbNow} GB`}`);
  lines.push(`readings: ${report.samples} in the last ${report.windowHours} hours`);
  if (report.gbPerHour === null) lines.push('use rate: unknown');
  else if (report.gbPerHour > 0) lines.push(`use rate: ${report.gbPerHour} GB per hour`);
  else lines.push('use rate: not shrinking');
  if (report.hoursUntilTargetFreeGb === null) {
    // A proven non-shrinking trend is not "unknown" — it never reaches the mark at this rate.
    lines.push(`${report.targetFreeGb} GB free in: ${report.gbPerHour !== null ? 'not at this rate' : 'unknown'}`);
  } else if (report.hoursUntilTargetFreeGb === 0) {
    lines.push(`${report.targetFreeGb} GB free in: already there`);
  } else {
    lines.push(`${report.targetFreeGb} GB free in: ${report.hoursUntilTargetFreeGb} hours`);
  }
  lines.push(`largest folders under ${displayDir(report.runsDir)}:`);
  if (report.largestSubdirs === null) lines.push('  unknown');
  else if (report.largestSubdirs.length === 0) lines.push('  none');
  else for (const dir of report.largestSubdirs) {
    // A measured dir that rounds to 0.0 GB read fine — say so, never "unknown".
    lines.push(`  ${dir.name}: ${dir.gb === 0 ? '<0.1' : dir.gb} GB`);
  }
  return lines;
}

export async function cmdFleetDisk(args: string[], deps: FleetDiskDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  let json = false;
  let runsRoot = deps.runsRoot;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      output.log('ashlr fleet disk [--runs-dir <abs>] [--json]\n' +
        'Read-only disk-pressure view: free-GB trend from LEADER rows in the last\n' +
        '12 hours and the ten largest folders under ~/.ashlr-runs. Unread\n' +
        'sources print unknown, never zero.');
      return 0;
    }
    if (seen.has(arg)) { output.error(`error: duplicate option\n${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--runs-dir') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) { output.error(`error: --runs-dir needs an absolute path\n${USAGE}`); return 2; }
      runsRoot = value;
    } else if (arg === '--json') json = true;
    else { output.error(`error: invalid argument\n${USAGE}`); return 2; }
  }
  const report = await readFleetDisk({ ...deps, runsRoot });
  if (json) output.log(JSON.stringify(sanitizePublicJson(report)));
  else for (const line of formatFleetDisk(report)) output.log(line);
  return 0;
}
