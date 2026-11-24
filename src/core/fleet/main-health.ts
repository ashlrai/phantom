/**
 * Read-only view of the main-guardian status table
 * (`<runs>/supervisor/status-main-guardian.md`): which repo's default branch is
 * red, what failed, and which fix jobs are open. Parsing is pure and never
 * throws; the reader is bounded and writes nothing.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLedgerTs } from '../metrics/loop.js';
import { localTimestamp, readSource } from './runs-parked-queue.js';

export const MAIN_HEALTH_STALE_MS = 30 * 60_000;
/** Empty fix attempts for one failure before further automatic retries are held. */
export const MAIN_HEALTH_EMPTY_LIMIT = 2;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_ROWS = 64;
const MAX_CELL = 200;
const SHA = /^[0-9a-f]{7,40}$/i;
const HEADING = /^# Main guardian status \((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?: [A-Za-z]{1,5})?\)/m;

export interface FleetMainHealthRepo {
  repo: string;
  branch: string;
  sha: string | null;
  state: 'green' | 'red' | 'unknown';
  checkedAt: string | null;
  failingCheck: string | null;
  fixJobs: string[];
  /** Empty fix attempts recorded for this red failure's retired jobs (0 when none). */
  emptyAttempts: number;
  /** True once empty attempts reach MAIN_HEALTH_EMPTY_LIMIT: stop retrying, a person or agent must act. */
  retryHold: boolean;
  nightlyRed: string | null;
}
export interface FleetMainHealthV1 {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'unavailable';
  statusAt: string | null;
  stale: boolean;
  guardianOff: boolean;
  red: number;
  repos: FleetMainHealthRepo[];
}

// eslint-disable-next-line no-control-regex -- table cells must not carry control bytes.
const cell = (raw: string | undefined): string => (raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_CELL);
const orNull = (value: string): string | null => value || null;

/** Pure: the table in `text`, with the staleness verdict taken against `nowMs`. */
export function parseMainGuardianStatus(text: string, nowMs: number): Omit<FleetMainHealthV1, 'source' | 'guardianOff'> {
  const heading = HEADING.exec(text);
  const stamp = heading ? localTimestamp(heading[1]!) : null;
  const statusMs = stamp && Number.isFinite(stamp.ms) ? stamp.ms : null;
  const repos: FleetMainHealthRepo[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (repos.length >= MAX_ROWS) break;
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell);
    if (cells.length < 4 || !cells[0] || !cells[1] || cells[0] === 'repo' || /^[-:\s]+$/.test(cells.slice(0, 2).join(''))) continue;
    const state = cells[3]!.toLowerCase();
    const checked = cells[4] ? localTimestamp(cells[4]) : null;
    repos.push({
      repo: cells[0],
      branch: cells[1],
      sha: SHA.test(cells[2]!) ? cells[2]! : null,
      state: state === 'green' || state === 'red' ? state : 'unknown',
      checkedAt: checked && Number.isFinite(checked.ms) ? checked.at : null,
      failingCheck: orNull(cells[5] ?? ''),
      fixJobs: (cells[6] ?? '').split(/[,\s]+/).filter(Boolean),
      emptyAttempts: 0,
      retryHold: false,
      nightlyRed: orNull(cells[7] ?? ''),
    });
  }
  return {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    statusAt: stamp && statusMs !== null ? stamp.at : null,
    stale: statusMs === null || nowMs - statusMs > MAIN_HEALTH_STALE_MS,
    red: repos.filter((repo) => repo.state === 'red').length,
    repos,
  };
}

/** jobs.jsonl field dialects, the same sets dispatchd `_vc_pick` accepts:
 * ids job|job_id|jobId|id, events event|type|kind ('published' normalizes
 * to publish), timestamps ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt. */
const LEDGER_JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const LEDGER_EVENT_KEYS = ['event', 'type', 'kind'] as const;
const LEDGER_TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const LEDGER_EVENTS = new Set(['launch', 'claim', 'finish', 'publish', 'outcome']);

const ledgerPick = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

/** First parseable stamp among the ledger's timestamp fields. */
function ledgerTs(row: Record<string, unknown>): number {
  for (const key of LEDGER_TS_KEYS) {
    const at = parseLedgerTs(row[key]);
    if (at !== null) return at;
  }
  return NaN;
}

/**
 * Jobs whose latest attempt finished empty, with how many distinct empty finishes
 * that failure has had since its last publication or non-empty finish. An empty
 * finish is never an active repair and never proves CI green.
 */
function emptyFixJobs(text: string, jobs: Set<string>, now: number): Map<string, number> {
  type Attempt = { launch: number; finish: number; empty: boolean; published: number; invalid: boolean; empties: Set<number> };
  const attempts = new Map<string, Attempt>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
      row = value as Record<string, unknown>;
    } catch { return new Map(); } // Incomplete evidence cannot retire an active job.
    const job = ledgerPick(row, LEDGER_JOB_KEYS);
    let event = ledgerPick(row, LEDGER_EVENT_KEYS);
    if (event === 'published') event = 'publish';
    if (job === null || !jobs.has(job) || event === null || !LEDGER_EVENTS.has(event)) continue;
    const attempt = attempts.get(job) ?? { launch: -Infinity, finish: -Infinity, empty: false, published: -Infinity, invalid: false, empties: new Set<number>() };
    const at = ledgerTs(row);
    if (!Number.isFinite(at) || at > now) attempt.invalid = true;
    else if (event === 'launch' || event === 'claim') attempt.launch = Math.max(attempt.launch, at);
    else if (event === 'finish') {
      if (at > attempt.finish) { attempt.finish = at; attempt.empty = row.empty === true; }
      else if (at === attempt.finish) attempt.empty = attempt.empty && row.empty === true;
      // Duplicate rows share a timestamp, so one attempt counts once.
      if (row.empty === true) attempt.empties.add(at); else attempt.empties.clear();
    } else {
      attempt.published = Math.max(attempt.published, at);
      for (const t of attempt.empties) if (t < at) attempt.empties.delete(t);
    }
    attempts.set(job, attempt);
  }
  return new Map([...attempts]
    .filter(([, a]) => !a.invalid && a.empty && a.finish > a.launch && a.published < a.launch)
    .map(([job, a]): [string, number] => [job, a.empties.size]));
}

export async function readFleetMainHealth(opts: { runsDir?: string; now?: () => number } = {}): Promise<FleetMainHealthV1> {
  const now = (opts.now ?? Date.now)();
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const [source, off] = await Promise.all([
    readSource(join(root, 'supervisor', 'status-main-guardian.md'), MAX_STATUS_BYTES, false),
    stat(join(root, 'queue', 'MAIN_GUARDIAN_OFF')).then(() => true, () => false),
  ]);
  if (source.state !== 'healthy') {
    return { v: 1, generatedAt: new Date(now).toISOString(), source: 'unavailable', statusAt: null, stale: true, guardianOff: off, red: 0, repos: [] };
  }
  const report = parseMainGuardianStatus(source.text, now);
  const jobs = new Set(report.repos.filter(repo => repo.state === 'red').flatMap(repo => repo.fixJobs));
  if (jobs.size) {
    const ledger = await readSource(join(root, 'metrics', 'jobs.jsonl'), 256 * 1024, true);
    if (ledger.state === 'healthy') {
      const empty = emptyFixJobs(ledger.text, jobs, now);
      for (const repo of report.repos) {
        if (repo.state !== 'red') continue;
        // Counts are per repo failure: another repo's empty attempts never hold this one.
        repo.emptyAttempts = repo.fixJobs.reduce((sum, job) => sum + (empty.get(job) ?? 0), 0);
        repo.fixJobs = repo.fixJobs.filter(job => !empty.has(job));
        repo.retryHold = repo.fixJobs.length === 0 && repo.emptyAttempts >= MAIN_HEALTH_EMPTY_LIMIT;
      }
    }
  }
  return { ...report, source: 'ok', guardianOff: off };
}
