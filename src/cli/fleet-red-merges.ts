/**
 * `ashlr fleet red-merges` — read-only per-hour rollup of merges landed on
 * red vs green checks, per lane, over the trailing window (24 h by default).
 *
 * Merge rows in <root>/metrics/jobs.jsonl (an outcome row whose state is
 * MERGED, or an equivalent merge word/boolean) count once per job — the
 * earliest in-window instant wins. The lane comes from the row's own lane
 * field, else from the job's launch row joined by job id, else
 * `unattributed`. A source that cannot be read prints `unknown`, never zero.
 *
 * Never writes, never routes, never touches merge or dispatch authority.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const usage = 'Usage: ashlr fleet red-merges [--root <dir>] [--hours <1..168>] [--json]';
const MAX_JOBS_BYTES = 32 * 1024 * 1024;
const HOUR_MS = 3_600_000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const LAUNCH_WORDS = new Set(['launch', 'launched', 'start', 'started', 'dispatch', 'dispatched', 'claim', 'claimed', 'running']);
const MERGE_WORDS = new Set(['land', 'landed', 'merge', 'merged', 'pr-merge', 'pr-merged', 'auto-merge', 'automerge', 'auto-merged']);
const EVENT_KEYS = ['event', 'type', 'transition', 'action', 'verb', 'kind'] as const;
const PHASE_KEYS = ['outcome', 'to', 'status', 'state', 'next', 'newStatus'] as const;
const TS_KEYS = ['mergedAt', 'landedAt', 'completedAt', 'ts', 'at', 'time', 'timestamp', 'recordedAt', 'updatedAt'] as const;
const CHECKS_KEYS = ['checks', 'checksState', 'checkState', 'ci'] as const;

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const pickString = (row: Row, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};
const bounded = (value: string | null, re: RegExp): string | null =>
  value !== null && re.test(value) ? value : null;
const jobOf = (row: Row): string | null => bounded(pickString(row, ['job', 'job_id', 'jobId', 'id']), JOB_ID);
const laneOf = (row: Row): string | null => bounded(pickString(row, ['lane', 'pool', 'account']), LANE_ID);
const msOf = (row: Row): number | null => {
  for (const key of TS_KEYS) {
    const ms = Date.parse(pickString(row, [key]) ?? '');
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};
const hasWord = (row: Row, keys: readonly string[], words: Set<string>): boolean =>
  keys.some(key => words.has((pickString(row, [key]) ?? '').toLowerCase()));
const isLaunch = (row: Row): boolean => hasWord(row, EVENT_KEYS, LAUNCH_WORDS) || hasWord(row, PHASE_KEYS, LAUNCH_WORDS);
const isMerge = (row: Row): boolean => hasWord(row, EVENT_KEYS, MERGE_WORDS) || hasWord(row, PHASE_KEYS, MERGE_WORDS)
  || row['landed'] === true || row['merged'] === true;
/** `checks` may be a bare string or a ChecksMemo-shaped { state/status/conclusion }. */
const checksOf = (row: Row): ChecksBucket => {
  const raw = pickString(row, CHECKS_KEYS) ?? (record(row['checks']) && pickString(record(row['checks'])!, ['state', 'status', 'conclusion']));
  const value = raw?.toLowerCase();
  return value === 'red' || value === 'green' ? value : 'other';
};

export type ChecksBucket = 'red' | 'green' | 'other';
export type RedMergesSource = 'healthy' | 'missing' | 'unreadable' | 'degraded';
export interface RedMergesLane { lane: string; red: number; green: number; other: number }
export interface RedMergesHour {
  /** ISO start of the one-hour bucket; `hours` buckets tile [now-hours, now]. */
  start: string;
  /** Merge count across lanes; 'unknown' when the ledger could not be read. */
  merges: number | 'unknown';
  lanes: RedMergesLane[];
}
export interface RedMergesReport {
  schema: 'fleet.red-merges.v1'; generatedAt: string; hours: number;
  source: RedMergesSource; malformed: number;
  merges: number | 'unknown';
  window: RedMergesHour[];
}
export interface FleetRedMergesDeps {
  /** jobs.jsonl text for a runs root; null when the ledger is absent. */
  readJobs?: (root: string) => Promise<string | null>;
  now?: () => number;
}

/** Bounded, no-follow read of one regular file. */
async function readBounded(path: string, max: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max) throw new Error('unavailable');
    const buffer = Buffer.alloc(max + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > max) throw new Error('unavailable');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
}

/** An absent metrics file reports as missing; other read failures propagate. */
export async function readRedMergesJobs(root: string): Promise<string | null> {
  try {
    return await readBounded(join(root, 'metrics', 'jobs.jsonl'), MAX_JOBS_BYTES);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code))) return null;
    throw error;
  }
}

/** Fold the ledger into per-hour, per-lane merges split by the checks value. */
export function foldRedMerges(text: string, hours: number, nowMs: number): { window: RedMergesHour[]; malformed: number } {
  const rows: { row: Row; index: number }[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    let row: Row | null = null;
    try { row = record(JSON.parse(line)); } catch { /* counted below */ }
    if (row === null) malformed++;
    else rows.push({ row, index: rows.length });
  }
  // job→lane from launch rows only; the newest launch wins the join.
  const jobLane = new Map<string, string>();
  for (const { row } of rows) {
    if (!isLaunch(row)) continue;
    const job = jobOf(row), lane = laneOf(row);
    if (job !== null && lane !== null) jobLane.set(job, lane);
  }
  const cutoff = nowMs - hours * HOUR_MS;
  // One merge per identity (job id, else PR text, else the row itself), kept
  // at its earliest in-window instant — duplicate appends never double-count.
  const merges = new Map<string, { ms: number; lane: string; checks: ChecksBucket }>();
  for (const { row, index } of rows) {
    if (!isMerge(row)) continue;
    const ms = msOf(row);
    if (ms === null || ms < cutoff || ms > nowMs) continue;
    const job = jobOf(row);
    const key = job ?? pickString(row, ['url', 'pr_url', 'prUrl', 'pr']) ?? `row-${index}`;
    const lane = laneOf(row) ?? (job !== null ? jobLane.get(job) : null) ?? 'unattributed';
    const existing = merges.get(key);
    if (existing === undefined || ms < existing.ms) merges.set(key, { ms, lane, checks: checksOf(row) });
  }
  const lanesAt = Array.from({ length: hours }, () => new Map<string, RedMergesLane>());
  const totalsAt = Array.from({ length: hours }, () => ({ red: 0, green: 0, other: 0, merges: 0 }));
  for (const merge of merges.values()) {
    const slot = Math.min(hours - 1, Math.floor((merge.ms - cutoff) / HOUR_MS));
    const lanes = lanesAt[slot]!;
    const tally = totalsAt[slot]!;
    const lane = lanes.get(merge.lane) ?? { lane: merge.lane, red: 0, green: 0, other: 0 };
    lane[merge.checks]++;
    tally[merge.checks]++;
    tally.merges++;
    lanes.set(merge.lane, lane);
  }
  const window: RedMergesHour[] = totalsAt.map((tally, i) => ({
    start: new Date(cutoff + i * HOUR_MS).toISOString(),
    merges: tally.merges,
    lanes: [...lanesAt[i]!.values()].sort((a, b) => a.lane.localeCompare(b.lane)),
  }));
  return { window, malformed };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const hourLine = (hour: RedMergesHour): string => {
  if (hour.merges === 'unknown') return `${hour.start}  unknown`;
  if (hour.merges === 0) return `${hour.start}  no merges`;
  const lanes = hour.lanes.map(lane => `${lane.lane}: red ${lane.red}, green ${lane.green}, other ${lane.other}`).join('; ');
  return `${hour.start}  ${plural(hour.merges, 'merge')} — ${lanes}`;
};

export async function cmdFleetRedMerges(args: string[], deps: FleetRedMergesDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\n` +
      'Per hour in the last --hours: merges landed on red checks, green checks\n' +
      'or anything else, per lane, from metrics/jobs.jsonl outcome rows joined\n' +
      'to launch rows by job id. A ledger that cannot be read prints unknown,\n' +
      'never zero. Read-only; never dispatches or mutates.');
    return 0;
  }
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let hours = 24;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--hours', '--root'].includes(arg)) {
      console.error(`error: invalid fleet red-merges arguments\n${usage}`);
      return 2;
    }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--hours') {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 168) {
        console.error(`error: --hours must be within 1..168\n${usage}`);
        return 2;
      }
      hours = Number(value);
    } else {
      const value = args[++i];
      if (!value || !isAbsolute(value)) {
        console.error(`error: --root needs an absolute directory\n${usage}`);
        return 2;
      }
      root = value;
    }
  }
  const now = deps.now ?? Date.now;
  const nowMs = now();
  if (!Number.isFinite(nowMs)) {
    console.error('fleet red-merges: metrics unavailable');
    return 1;
  }
  let text: string | null = null;
  let unreadable = false;
  try {
    text = await (deps.readJobs ?? readRedMergesJobs)(root);
  } catch {
    unreadable = true;
  }
  const folded = text === null ? null : foldRedMerges(text, hours, nowMs);
  const cutoff = nowMs - hours * HOUR_MS;
  const window: RedMergesHour[] = folded?.window ?? Array.from({ length: hours }, (_, i) => ({
    start: new Date(cutoff + i * HOUR_MS).toISOString(), merges: 'unknown' as const, lanes: [],
  }));
  const report: RedMergesReport = {
    schema: 'fleet.red-merges.v1',
    generatedAt: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
    hours,
    source: text === null ? (unreadable ? 'unreadable' : 'missing') : folded!.malformed > 0 ? 'degraded' : 'healthy',
    malformed: folded?.malformed ?? 0,
    merges: folded === null ? 'unknown' : window.reduce((sum, hour) => sum + (hour.merges as number), 0),
    window,
  };
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    for (const hour of report.window) console.log(hourLine(hour));
    if (report.malformed > 0) console.log(`malformed rows: ${report.malformed}`);
  }
  return unreadable ? 1 : 0;
}
