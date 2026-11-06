/**
 * `ashlr fleet lane-merges` — read-only per-lane launch/PR/merge rollup over a
 * host metrics ledger (<root>/metrics/jobs.jsonl; default ~/.ashlr-runs).
 *
 * Launch and outcome rows join by job id: an outcome or publish row that omits
 * its lane takes the lane its job launched under. Per lane the command prints
 * launches, unique PR urls and merges inside the trailing window (24 h by
 * default). Lane limits come only from the queue's slots.json `target` — an
 * absent or unreadable source reads as `unknown`, never a guess.
 *
 * Never writes, never routes, never touches merge or dispatch authority.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const usage = 'Usage: ashlr fleet lane-merges [--root <dir>] [--hours <1..168>] [--json]';
const MAX_JOBS_BYTES = 32 * 1024 * 1024;
const MAX_SLOTS_BYTES = 64 * 1024;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const LAUNCH_WORDS = new Set(['launch', 'launched', 'start', 'started', 'dispatch', 'dispatched', 'claim', 'claimed', 'running']);
const MERGE_WORDS = new Set(['land', 'landed', 'merge', 'merged', 'pr-merge', 'pr-merged', 'auto-merge', 'automerge', 'auto-merged']);
const EVENT_KEYS = ['event', 'type', 'transition', 'action', 'verb', 'kind'] as const;
const PHASE_KEYS = ['outcome', 'to', 'status', 'state', 'next', 'newStatus'] as const;
const EVENT_TS_KEYS = ['ts', 'at', 'time', 'timestamp', 'recordedAt', 'updatedAt', 'completedAt', 'landedAt', 'mergedAt'] as const;
const MERGE_TS_KEYS = ['mergedAt', 'landedAt', 'completedAt', 'ts', 'at', 'time', 'timestamp', 'recordedAt', 'updatedAt'] as const;

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
const msOf = (row: Row, keys: readonly string[]): number | null => {
  for (const key of keys) {
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
/** GitHub pull urls fold to owner/repo#n; other spellings keep their own text. */
const prOf = (row: Row): string | null => {
  const value = pickString(row, ['url', 'pr_url', 'prUrl', 'pr']);
  if (value === null || value.length > 512) return null;
  const match = /^https:\/\/github\.com\/([a-z\d_.-]+)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(value);
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}` : value;
};

export type LaneSourceState = 'healthy' | 'missing' | 'degraded';
export interface LaneLimitsRead { state: LaneSourceState; limits: Map<string, number> }
export interface LaneMergesRow {
  lane: string; launches: number; prs: number; prUrls: string[]; merges: number;
  /** Configured slot target from slots.json; null when no real source read it. */
  limit: number | null;
}
export interface LaneMergesReport {
  schema: 'fleet.lane-merges.v1'; generatedAt: string; hours: number;
  source: LaneSourceState; limits: LaneSourceState; malformed: number;
  lanes: LaneMergesRow[];
}
export interface FleetLaneMergesDeps {
  /** jobs.jsonl text for a runs root; null when the ledger is absent. */
  readJobs?: (root: string) => Promise<string | null>;
  /** slots.json lane targets for a runs root; never guessed. */
  readLimits?: (root: string) => Promise<LaneLimitsRead>;
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
export async function readLaneMergesJobs(root: string): Promise<string | null> {
  try {
    return await readBounded(join(root, 'metrics', 'jobs.jsonl'), MAX_JOBS_BYTES);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code))) return null;
    throw error;
  }
}

/** slots.json lane targets; a lane without a readable target simply has none. */
export async function readLaneMergesLimits(root: string): Promise<LaneLimitsRead> {
  let text: string;
  try {
    text = await readBounded(join(root, 'queue', 'slots.json'), MAX_SLOTS_BYTES);
  } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code));
    return { state: missing ? 'missing' : 'degraded', limits: new Map() };
  }
  try {
    const raw = record(JSON.parse(text));
    const lanes = raw ? (record(raw['lanes']) ?? raw) : null;
    if (lanes === null) return { state: 'degraded', limits: new Map() };
    const limits = new Map<string, number>();
    let dropped = 0;
    for (const [name, entry] of Object.entries(lanes)) {
      const target = typeof entry === 'number' ? entry : record(entry)?.['target'];
      if (LANE_ID.test(name) && typeof target === 'number' && Number.isSafeInteger(target) && target >= 0 && target <= 10_000) {
        limits.set(name, target);
      } else dropped++;
    }
    return { state: dropped > 0 ? 'degraded' : 'healthy', limits };
  } catch {
    return { state: 'degraded', limits: new Map() };
  }
}

/** Fold the ledger into per-lane launch/PR/merge counts inside [now-hours, now]. */
export function foldLaneMerges(text: string, hours: number, nowMs: number): { lanes: LaneMergesRow[]; malformed: number } {
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
  // job→lane from every row that honestly carries both; last observation wins.
  const jobLane = new Map<string, string>();
  for (const { row } of rows) {
    const job = jobOf(row), lane = laneOf(row);
    if (job !== null && lane !== null) jobLane.set(job, lane);
  }
  const cutoff = nowMs - hours * 3_600_000;
  const inWindow = (ms: number | null): ms is number => ms !== null && ms >= cutoff && ms <= nowMs;
  const lanesSeen = new Set<string>();
  const launches = new Map<string, number>();
  const launchDedupe = new Set<string>();
  const prs = new Map<string, Set<string>>();
  const mergeCandidates = new Map<string, { job: string | null; pr: string | null; key: string }[]>();
  const acc = <T>(map: Map<string, T>, lane: string, make: () => T): T => {
    const existing = map.get(lane);
    if (existing !== undefined) return existing;
    const created = make();
    map.set(lane, created);
    return created;
  };
  for (const { row, index } of rows) {
    const job = jobOf(row);
    const lane = laneOf(row) ?? (job !== null ? jobLane.get(job) ?? null : null);
    if (lane === null) continue;
    const eventMs = msOf(row, EVENT_TS_KEYS);
    let touched = false;
    // A launch row's own instant, or a job row's startedAt, inside the window.
    const launchMs = (isLaunch(row) ? eventMs : null) ?? msOf(row, ['startedAt']);
    if (inWindow(launchMs)) {
      const key = `${job ?? `row-${index}`}@${launchMs}`;
      if (!launchDedupe.has(key)) {
        launchDedupe.add(key);
        launches.set(lane, (launches.get(lane) ?? 0) + 1);
        touched = true;
      }
    }
    const pr = prOf(row);
    if (pr !== null && inWindow(eventMs)) {
      acc(prs, lane, () => new Set()).add(pr);
      touched = true;
    }
    const mergeMs = isMerge(row) ? msOf(row, MERGE_TS_KEYS) : null;
    if (inWindow(mergeMs)) {
      acc(mergeCandidates, lane, () => []).push({ job, pr, key: `row-${index}` });
      touched = true;
    }
    if (touched) lanesSeen.add(lane);
  }
  // Prefer PR identity per merge; a job-only observation of a PR-known job is a
  // duplicate — same convention as the lane console's merges-per-hour count.
  const jobsWithPr = new Set(
    [...mergeCandidates.values()].flat().filter(c => c.pr !== null && c.job !== null).map(c => c.job!),
  );
  const lanes: LaneMergesRow[] = [];
  for (const lane of lanesSeen) {
    const seen = new Set<string>();
    let merges = 0;
    for (const candidate of mergeCandidates.get(lane) ?? []) {
      if (candidate.pr === null && candidate.job !== null && jobsWithPr.has(candidate.job)) continue;
      const key = candidate.pr !== null ? `pr:${candidate.pr}` : candidate.job !== null ? `job:${candidate.job}` : candidate.key;
      if (seen.has(key)) continue;
      seen.add(key);
      merges++;
    }
    const prUrls = [...(prs.get(lane) ?? [])].sort((a, b) => a.localeCompare(b));
    lanes.push({ lane, launches: launches.get(lane) ?? 0, prs: prUrls.length, prUrls, merges, limit: null });
  }
  lanes.sort((a, b) => a.lane.localeCompare(b.lane));
  return { lanes, malformed };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export async function cmdFleetLaneMerges(args: string[], deps: FleetLaneMergesDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\n` +
      'Per lane in the last --hours: launches, unique PR urls and merges, joined\n' +
      'from metrics/jobs.jsonl by job id, plus the slots.json lane limit (unknown\n' +
      'when no real source read it). Read-only; never dispatches or mutates.');
    return 0;
  }
  let root = join(homedir(), '.ashlr-runs');
  let hours = 24;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--hours', '--root'].includes(arg)) {
      console.error(`error: invalid fleet lane-merges arguments\n${usage}`);
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
    console.error('fleet lane-merges: metrics unavailable');
    return 1;
  }
  let text: string | null;
  try {
    text = await (deps.readJobs ?? readLaneMergesJobs)(root);
  } catch {
    console.error('fleet lane-merges: metrics unavailable');
    return 1;
  }
  let limitsRead: LaneLimitsRead = { state: 'degraded', limits: new Map() };
  try {
    limitsRead = await (deps.readLimits ?? readLaneMergesLimits)(root);
  } catch {
    limitsRead = { state: 'degraded', limits: new Map() };
  }
  const folded = foldLaneMerges(text ?? '', hours, nowMs);
  // Lanes with a configured limit but no windowed activity still get a line.
  const known = new Set(folded.lanes.map(row => row.lane));
  for (const lane of limitsRead.limits.keys()) {
    if (!known.has(lane)) folded.lanes.push({ lane, launches: 0, prs: 0, prUrls: [], merges: 0, limit: null });
  }
  folded.lanes.sort((a, b) => a.lane.localeCompare(b.lane));
  for (const row of folded.lanes) row.limit = limitsRead.limits.get(row.lane) ?? null;
  const report: LaneMergesReport = {
    schema: 'fleet.lane-merges.v1',
    generatedAt: new Date(nowMs).toISOString(),
    hours,
    source: text === null ? 'missing' : folded.malformed > 0 ? 'degraded' : 'healthy',
    limits: limitsRead.state,
    malformed: folded.malformed,
    lanes: folded.lanes,
  };
  if (json) {
    console.log(JSON.stringify(report));
    return 0;
  }
  if (report.lanes.length === 0) {
    console.log(`no lane activity in the last ${plural(hours, 'hour')}${text === null ? ' (jobs ledger missing)' : ''}`);
    return 0;
  }
  for (const row of report.lanes) {
    console.log(`${row.lane}: ${plural(row.launches, 'launch')}, ${plural(row.prs, 'PR')}, ${plural(row.merges, 'merge')}, limit ${row.limit ?? 'unknown'}`);
  }
  if (report.limits !== 'healthy') console.log(`lane limits unknown (slots.json ${report.limits})`);
  if (report.malformed > 0) console.log(`malformed rows: ${report.malformed}`);
  return 0;
}
