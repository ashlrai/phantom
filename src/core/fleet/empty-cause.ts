/**
 * Typed causes for jobs that finished EMPTY (RQ-EMPTYCAUSEN16LQ8).
 *
 * Reads the jobs ledger for empty finishes, then the tail of each job's worker
 * log (`<runs>/<job>.log`, beside `<job>.publish`) and tags the empty with one
 * cause. Only the final lines are read: the head of a log echoes the prompt,
 * which itself names phrases like "NO CANDIDATE". No match stays `unknown`.
 * Read-only; bounded, no-follow reads through readSource.
 */
import { join } from 'node:path';
import { parseLedgerTs } from '../metrics/loop.js';
import { readSource } from './runs-parked-queue.js';

export const EMPTY_CAUSES = ['sandbox_denied', 'no_candidate', 'precheck_skip', 'tool_missing', 'timeout', 'model_error', 'unknown'] as const;
export type EmptyCause = (typeof EMPTY_CAUSES)[number];

/** Lines of the log tail that count as the worker's final message. */
export const EMPTY_CAUSE_TAIL_LINES = 40;
const LOG_TAIL_BYTES = 64 * 1024;
const LEDGER_TAIL_BYTES = 8 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// First match wins. A machine-written precheck marker is the most specific;
// a sandbox denial outranks a worker's own "nothing to do" verdict because a
// worker that cannot run gh often concludes there is no candidate.
const RULES: ReadonlyArray<readonly [Exclude<EmptyCause, 'unknown'>, RegExp]> = [
  ['precheck_skip', /\bprecheck[ _-]?(?:code|exit|skip(?:ped)?)\b/i],
  ['sandbox_denied', /operation not permitted|\bgh(?: cli)? (?:is )?not logged in|not logged in(?:to)? (?:to )?any github hosts|\bsandbox(?:-exec)?\b[^\n]{0,40}\b(?:deny|denied|blocked)\b/i],
  ['tool_missing', /command not found|\bspawn \S+ ENOENT\b|executable file not found|\bis not installed\b/i],
  ['model_error', /usage limit|rate[ -]?limit|\boverloaded\b|\bAPI Error\b|status(?: code)? (?:429|5\d\d)\b|context (?:length|window) exceeded|credit balance/i],
  ['no_candidate', /\bNO[ _-]CANDIDATE\b|already (?:on|in|landed on|merged (?:in|to|into)) (?:origin\/)?(?:master|main)\b/i],
  ['timeout', /\btimed out\b|\btimeout after\b|deadline exceeded/i],
];

/** Pure: tag one empty job. `timedOut` is the dispatcher's `.timeout` marker. */
export function classifyEmptyCause(log: string | null, timedOut = false): EmptyCause {
  if (timedOut) return 'timeout';
  if (log === null) return 'unknown';
  const tail = log.split(/\r?\n/).slice(-EMPTY_CAUSE_TAIL_LINES).join('\n');
  return RULES.find(([, re]) => re.test(tail))?.[0] ?? 'unknown';
}

const REASON: Record<EmptyCause, string> = {
  sandbox_denied: 'gh or a file was blocked in the sandbox',
  no_candidate: 'there was nothing left to do (no candidate, or already on master)',
  precheck_skip: 'the precheck skipped them',
  tool_missing: 'a tool they needed was not installed',
  timeout: 'they ran out of time',
  model_error: 'the model or its API failed (limit, overload or error)',
  unknown: 'of a cause not recognised in the final log lines',
};
export const emptyCauseLine = (lane: string, cause: EmptyCause, count: number): string =>
  `${lane}: ${count} ${count === 1 ? 'job' : 'jobs'} ended empty because ${REASON[cause]}`;

/** RQ-PHX-FOO03 -> RQ-PHX-FOO (same rule as fleet task-check batches). */
export const jobPrefix = (job: string): string => job.replace(/\d+$/, '') || job;

export interface EmptyFinish { id: string; lane: string; wallSeconds: number | null }
/** `notes` is the job's own result notes (BRIDGE_NOTES.md), read by `phm empties` only. */
export interface EmptyEvidence { log: string | null; timedOut: boolean; notes?: string | null }
export interface EmptyCauseGroup {
  lane: string; cause: EmptyCause; prefix: string; count: number;
  examples: string[]; median_wall_seconds: number | null;
}
export interface EmptyCauseTop { lane: string; cause: EmptyCause; count: number; line: string }
export interface EmptyCauseSummary {
  /** null when the jobs ledger is unreadable. */
  total: number | null;
  /** Empties whose log was missing or unreadable (they classify as unknown unless timed out). */
  logs_missing: number;
  by_cause: Record<EmptyCause, number>;
  groups: EmptyCauseGroup[];
  top: EmptyCauseTop[];
}

const text = (value: unknown): string => {
  const s = typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, ' ').trim() : '';
  return s || 'unknown';
};
const seconds = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export interface LedgerRow { row: Record<string, unknown>; id: string; lane: string; at: number }

/**
 * jobs.jsonl field dialects, the same sets dispatchd `_vc_pick`,
 * metrics/loop and queue/job-outcomes accept: job ids take
 * job|job_id|jobId|id, the lane alias pool and timestamps
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt. `at` stays
 * the row's own stamp in dialect order — consumers that need the PR's own
 * mergedAt read that field themselves (merge-latency, throughput).
 */
const JOB_ID_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const LANE_KEYS = ['lane', 'pool'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;

const pickString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

/** First parseable stamp among the ledger's timestamp fields, in dialect order. */
function ledgerAt(row: Record<string, unknown>): number | null {
  for (const field of TS_KEYS) {
    const at = parseLedgerTs(row[field]);
    if (at !== null) return at;
  }
  return null;
}

/**
 * Pure: in-window ledger rows that name a safe job id. `malformed` counts non-blank lines that are not JSON objects.
 * `anyJob` also keeps rows with no job id (PR outcome rows are keyed by URL) under the id ''.
 */
export function ledgerRows(ledger: string, now: number, hours: number, anyJob = false): { rows: LedgerRow[]; malformed: number } {
  const rows: LedgerRow[] = [];
  let malformed = 0;
  for (const line of ledger.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed++; continue; }
      row = value as Record<string, unknown>;
    } catch { malformed++; continue; }
    const id = pickString(row, JOB_ID_KEYS) ?? (anyJob ? '' : null);
    // The id names a log file, so refuse anything that could leave the runs dir.
    if (id === null || !(SAFE_ID.test(id) || (anyJob && id === ''))) continue;
    const at = ledgerAt(row);
    if (at === null || at > now || at < now - hours * 3_600_000) continue;
    rows.push({ row, id, lane: text(pickString(row, LANE_KEYS)), at });
  }
  return { rows, malformed };
}

/** Pure: distinct jobs whose finish or outcome row says empty inside the window. */
export function emptyFinishes(ledger: string, now: number, hours: number): EmptyFinish[] {
  const jobs = new Map<string, EmptyFinish>();
  for (const { row, id, lane } of ledgerRows(ledger, now, hours).rows) {
    const empty = row.empty === true && (row.event === 'finish' || row.event === 'outcome')
      || [row.event, row.outcome, row.state].includes('EMPTY_DONE');
    if (!empty) continue;
    const seen = jobs.get(id);
    jobs.set(id, {
      id,
      lane: seen && seen.lane !== 'unknown' ? seen.lane : lane,
      wallSeconds: seen?.wallSeconds ?? seconds(row.wall_s),
    });
  }
  return [...jobs.values()];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Pure: classify and group. Top lines rank (lane, cause) pairs by count. */
export function summarizeEmptyCauses(jobs: EmptyFinish[], evidence: Map<string, EmptyEvidence>): EmptyCauseSummary {
  const by_cause = Object.fromEntries(EMPTY_CAUSES.map(c => [c, 0])) as Record<EmptyCause, number>;
  const groups = new Map<string, EmptyCauseGroup & { walls: number[] }>();
  const pairs = new Map<string, EmptyCauseTop>();
  let logs_missing = 0;
  for (const job of jobs) {
    const ev = evidence.get(job.id) ?? { log: null, timedOut: false };
    if (ev.log === null) logs_missing++;
    const cause = classifyEmptyCause(ev.log, ev.timedOut);
    by_cause[cause]++;
    const prefix = jobPrefix(job.id), key = JSON.stringify([job.lane, cause, prefix]);
    const group = groups.get(key) ?? { lane: job.lane, cause, prefix, count: 0, examples: [], median_wall_seconds: null, walls: [] };
    group.count++;
    if (group.examples.length < 2) group.examples.push(job.id);
    if (job.wallSeconds !== null) group.walls.push(job.wallSeconds);
    groups.set(key, group);
    const pairKey = JSON.stringify([job.lane, cause]);
    const pair = pairs.get(pairKey) ?? { lane: job.lane, cause, count: 0, line: '' };
    pair.count++; pairs.set(pairKey, pair);
  }
  const rank = <T extends { count: number; lane: string; cause: string }>(a: T, b: T) =>
    b.count - a.count || a.lane.localeCompare(b.lane) || EMPTY_CAUSES.indexOf(a.cause as EmptyCause) - EMPTY_CAUSES.indexOf(b.cause as EmptyCause);
  return {
    total: jobs.length,
    logs_missing,
    by_cause,
    groups: [...groups.values()]
      .map(({ walls, ...g }) => ({ ...g, median_wall_seconds: median(walls) }))
      .sort((a, b) => rank(a, b) || a.prefix.localeCompare(b.prefix)),
    top: [...pairs.values()].sort(rank).map(p => ({ ...p, line: emptyCauseLine(p.lane, p.cause, p.count) })),
  };
}

/** Fleet-wide causes, most frequent first; unknown is kept and ranked like any other. */
export function topEmptyCauses(summary: EmptyCauseSummary, n = 3): Array<{ cause: EmptyCause; count: number }> {
  return EMPTY_CAUSES.map(cause => ({ cause, count: summary.by_cause[cause] }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count || EMPTY_CAUSES.indexOf(a.cause) - EMPTY_CAUSES.indexOf(b.cause))
    .slice(0, n);
}

export async function readText(path: string, max: number): Promise<string | null> {
  try {
    const source = await readSource(path, max, true);
    return source.state === 'healthy' ? source.text : null;
  } catch { return null; }
}

export async function exists(path: string): Promise<boolean> {
  try { return (await readSource(path, 1, true)).state === 'healthy'; } catch { return false; }
}

/** Read the ledger and each empty job's log tail under `root` (the fleet runs dir). */
export async function readEmptyCauses(root: string, now: number, hours: number): Promise<EmptyCauseSummary> {
  const ledger = await readText(join(root, 'metrics', 'jobs.jsonl'), LEDGER_TAIL_BYTES);
  if (ledger === null) {
    return { total: null, logs_missing: 0, by_cause: summarizeEmptyCauses([], new Map()).by_cause, groups: [], top: [] };
  }
  const jobs = emptyFinishes(ledger, now, hours);
  const evidence = new Map<string, EmptyEvidence>();
  for (let i = 0; i < jobs.length; i += 16) {
    const batch = jobs.slice(i, i + 16);
    const read = await Promise.all(batch.map(async job => ({
      log: await readText(join(root, `${job.id}.log`), LOG_TAIL_BYTES),
      timedOut: await exists(join(root, 'queue', 'run', `${job.id}.timeout`)),
    })));
    batch.forEach((job, index) => evidence.set(job.id, read[index]!));
  }
  return summarizeEmptyCauses(jobs, evidence);
}
