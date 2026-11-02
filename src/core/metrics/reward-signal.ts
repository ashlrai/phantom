/**
 * reward-signal.ts — RQ-SELFOPT-REWARD-SIGNALS: the single per-job reward
 * signal writer and reader.
 *
 * When a dispatched job reaches a terminal state the supervising bridge calls
 * `writeRewardSignal` once. It appends exactly one scrubbed row to the
 * append-only ledger at `$ASHLR_HOME/metrics/reward-signals.jsonl`:
 *
 *   {"v":1,"jobId":...,"pool":...,"repo":...,"merged":bool,
 *    "dispatchedAt":iso,"mergedAt":iso|null,"timeToMergeMs":ms|null,
 *    "ciWallMs":ms|null,"cost":{...},"recordedAt":iso}
 *
 * The file is the shared reward substrate for three local consumers:
 *   - the router (`phm router-calibration --jobs <file>` accepts these rows;
 *     see routing/calibration.ts),
 *   - the eval harness (`readRewardSignals` / `latestRewardSignals`),
 *   - the dashboard (`latestRewardSignals`, one row per job).
 *
 * Discipline (mirrors telemetry.ts / usage-signal-writer.ts):
 *  - Metadata only: job ids, pool, repo, timestamps, durations and metered
 *    cost. No task text, prompts, diffs, PR titles or provider payloads.
 *  - Every string is a bounded token; secret-shaped values are refused before
 *    write (`assertNoSecrets`-equivalent), never scrubbed into place.
 *  - Append-only and idempotent: replaying the same terminal outcome returns
 *    `duplicate`; a conflicting outcome for a recorded jobId fails closed.
 *  - Cost comes from the existing usage readers (usage-readings.log): the
 *    subscription-pool percentage points consumed across the job window.
 *    A reset or missing reading leaves the delta null — unknown is never 0.
 *  - Directory 0700, file 0600, O_APPEND|O_NOFOLLOW, fsync before close.
 */
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import {
  acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock,
} from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped } from '../verse/preferences.js';
import type { UsageReading } from '../fabric/usage-signal-writer.js';

export const REWARD_SIGNAL_SCHEMA = 1;
/** Ledger read/write cap; a larger file is an integrity failure, never truncated evidence. */
export const REWARD_SIGNAL_MAX_BYTES = 16 * 1024 * 1024;
/** Skew allowance for caller-supplied terminal timestamps. */
const FUTURE_SKEW_MS = 60_000;
/** 64-hex runs inside identifiers are hashes (rq-<sha256> job ids), not secrets. */
const HASH_64 = /[0-9a-f]{64}/g;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POOL = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Metered cost of one job, derived from the existing usage readers. */
export interface RewardSignalCost {
  /** Subscription pool the job was metered against, when it had one. */
  pool: string | null;
  /** Pool % used at the reading bracketing dispatch (null: no reading). */
  pctUsedStart: number | null;
  /** Pool % used at the latest reading before recording (null: no reading). */
  pctUsedEnd: number | null;
  /** Percentage points consumed inside the job window. Null when a pool
   * window reset or missing readings make it unmeasurable — never 0 by fiat. */
  pctUsedDelta: number | null;
  /** USD estimate when a reader/report supplies one; subscription pools cannot. */
  costUsd: number | null;
}

/** What a supervisor reports at job completion. */
export interface RewardSignalInput {
  jobId: string;
  pool?: string | null;
  repo?: string | null;
  merged: boolean;
  /** ISO timestamp of the router dispatch that launched the job. */
  dispatchedAt: string;
  /** ISO timestamp of the independently verified merge. Required iff merged. */
  mergedAt?: string | null;
  /** CI wall time for the job's change; null when CI evidence is unavailable. */
  ciWallMs?: number | null;
  /** USD cost estimate when a usage reader/report supplies one. */
  costUsd?: number | null;
}

export interface RewardSignalV1 {
  v: typeof REWARD_SIGNAL_SCHEMA;
  jobId: string;
  pool: string | null;
  repo: string | null;
  merged: boolean;
  dispatchedAt: string;
  mergedAt: string | null;
  /** mergedAt − dispatchedAt; null unless merged. Derived, never caller-supplied. */
  timeToMergeMs: number | null;
  ciWallMs: number | null;
  cost: RewardSignalCost;
  recordedAt: string;
}

export type RewardSignalWriteResult =
  | { status: 'recorded'; row: RewardSignalV1 }
  | { status: 'duplicate'; row: RewardSignalV1 };

export interface RewardSignalWriteOptions {
  /** Ledger path; default `$ASHLR_HOME/metrics/reward-signals.jsonl`. */
  path?: string;
  /** usage-readings.log path to meter pool cost from, when the job had a pool. */
  usageLogPath?: string;
  /** Readings already in memory; wins over usageLogPath. */
  usageReadings?: readonly UsageReading[];
  /**
   * The subscription pool the job's usage readers meter (e.g. 'codex-cmp').
   * Defaults to the job's dispatch pool; set explicitly when a bridge job
   * (pool 'devin') runs against a different billing pool.
   */
  usagePool?: string | null;
  now?: () => Date;
}

export function rewardSignalPath(home: string = ashlrHome()): string {
  return join(home, 'metrics', 'reward-signals.jsonl');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
/** Caller input may omit millis or use an offset; stored rows are canonical UTC. */
function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function isNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isPercent(value: unknown): value is number {
  return isNonnegative(value) && value <= 100;
}

/** Refuse credential-shaped text; hashes embedded in identifiers are content. */
function assertCleanToken(value: string, field: string): void {
  const masked = value.replace(HASH_64, '');
  if (scrubSecrets(masked) !== masked) {
    throw new Error(`Refused: ${field} contains a credential-shaped value`);
  }
}

function validCost(value: unknown): value is RewardSignalCost {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return Object.keys(c).sort().join(',') === 'costUsd,pctUsedDelta,pctUsedEnd,pctUsedStart,pool' &&
    (c['pool'] === null || (typeof c['pool'] === 'string' && POOL.test(c['pool']))) &&
    (c['pctUsedStart'] === null || isPercent(c['pctUsedStart'])) &&
    (c['pctUsedEnd'] === null || isPercent(c['pctUsedEnd'])) &&
    (c['pctUsedDelta'] === null || isNonnegative(c['pctUsedDelta'])) &&
    (c['costUsd'] === null || isNonnegative(c['costUsd'])) &&
    (c['pctUsedDelta'] === null ||
      (c['pctUsedStart'] !== null && c['pctUsedEnd'] !== null &&
        c['pctUsedEnd'] >= c['pctUsedStart'] &&
        Math.abs((c['pctUsedDelta'] as number) - (c['pctUsedEnd'] - c['pctUsedStart'])) <= 1e-9));
}

export function isRewardSignalV1(value: unknown): value is RewardSignalV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r['v'] !== REWARD_SIGNAL_SCHEMA || typeof r['jobId'] !== 'string' || !JOB_ID.test(r['jobId']) ||
    (r['pool'] !== null && (typeof r['pool'] !== 'string' || !POOL.test(r['pool']))) ||
    (r['repo'] !== null && (typeof r['repo'] !== 'string' || !REPO.test(r['repo']))) ||
    typeof r['merged'] !== 'boolean' || !isTimestamp(r['dispatchedAt']) ||
    (r['mergedAt'] !== null && !isTimestamp(r['mergedAt'])) ||
    (r['timeToMergeMs'] !== null && !isNonnegative(r['timeToMergeMs'])) ||
    (r['ciWallMs'] !== null && !isNonnegative(r['ciWallMs'])) ||
    !isTimestamp(r['recordedAt']) || !validCost(r['cost'])) return false;
  if (r['merged'] !== (r['mergedAt'] !== null)) return false;
  const expected = r['merged'] ? Date.parse(r['mergedAt'] as string) - Date.parse(r['dispatchedAt'] as string) : null;
  if (expected === null ? r['timeToMergeMs'] !== null : r['timeToMergeMs'] !== expected) return false;
  return Object.keys(r).sort().join(',') ===
    'ciWallMs,cost,dispatchedAt,jobId,merged,mergedAt,pool,recordedAt,repo,timeToMergeMs,v';
}

/**
 * Pool cost across [windowStartMs, windowEndMs] from usage-reader readings.
 * The baseline is the last reading at/before dispatch; the end is the last
 * reading at/before recording, so pctUsedDelta bounds total pool consumption
 * over the job window (pool-level attribution, not per-job metering).
 * pctUsedDelta is null when the pool window reset inside the job (resetAt
 * moved or usage went backwards) or either bracketing reading is missing.
 */
export function usageCostFromReadings(
  readings: readonly UsageReading[], pool: string,
  windowStartMs: number, windowEndMs: number, costUsd: number | null = null,
): RewardSignalCost {
  const rows = readings
    .filter((r) => r && r.pool === pool && isTimestamp(r.writtenAt))
    .sort((a, b) => Date.parse(a.writtenAt) - Date.parse(b.writtenAt));
  let start: UsageReading | undefined;
  let end: UsageReading | undefined;
  for (const row of rows) {
    const at = Date.parse(row.writtenAt);
    if (at <= windowStartMs) start = row;
    if (at <= windowEndMs) end = row;
  }
  start ??= rows[0];
  const pctUsedStart = start?.pctUsed ?? null;
  const pctUsedEnd = end?.pctUsed ?? null;
  const delta = start !== undefined && end !== undefined && pctUsedStart !== null && pctUsedEnd !== null &&
    start.resetAt !== null && start.resetAt === end.resetAt && pctUsedEnd >= pctUsedStart
    ? pctUsedEnd - pctUsedStart : null;
  return { pool, pctUsedStart, pctUsedEnd, pctUsedDelta: delta, costUsd };
}

/** Tolerant line parse for consumers: one bad line never blinds the file. */
function parseLine(line: string): RewardSignalV1 | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRewardSignalV1(value) ? value : null;
  } catch {
    return null;
  }
}

/** Strict read for the writer's dedupe check: a corrupt ledger fails closed. */
function readLedgerStrict(path: string): RewardSignalV1[] {
  const file = readPrivateFileCapped(path, REWARD_SIGNAL_MAX_BYTES);
  if (!file) return [];
  if (file.truncated) throw new Error('Reward signal ledger exceeds the read bound');
  return file.text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    const row = parseLine(line);
    if (!row) throw new Error(`Invalid reward signal at line ${index + 1}`);
    return [row];
  });
}

/** All recorded rows in append order. Missing file reads as empty. */
export function readRewardSignals(path: string = rewardSignalPath()): RewardSignalV1[] {
  const file = readPrivateFileCapped(path, REWARD_SIGNAL_MAX_BYTES);
  if (!file) return [];
  if (file.truncated) throw new Error('Reward signal ledger exceeds the read bound');
  return file.text.split('\n').flatMap((line) => line.trim() ? [parseLine(line)] : [])
    .filter((row): row is RewardSignalV1 => row !== null);
}

/** One row per jobId (last write wins) — the router/eval/dashboard view. */
export function latestRewardSignals(path: string = rewardSignalPath()): RewardSignalV1[] {
  const latest = new Map<string, RewardSignalV1>();
  for (const row of readRewardSignals(path)) latest.set(row.jobId, row);
  return [...latest.values()];
}

/** Same terminal outcome = same call; derived cost fields and recordedAt are not outcome. */
function sameOutcome(a: RewardSignalV1, b: RewardSignalV1): boolean {
  return a.jobId === b.jobId && a.merged === b.merged && a.dispatchedAt === b.dispatchedAt &&
    a.mergedAt === b.mergedAt && a.pool === b.pool && a.repo === b.repo &&
    a.ciWallMs === b.ciWallMs && a.cost.pool === b.cost.pool && a.cost.costUsd === b.cost.costUsd;
}

/**
 * Record one job's terminal reward row. Validates input, derives timeToMergeMs
 * and pool cost, refuses secrets, then appends under the local-store lock.
 * Returns `duplicate` without appending when the same outcome was replayed.
 */
export function writeRewardSignal(
  input: RewardSignalInput, options: RewardSignalWriteOptions = {},
): RewardSignalWriteResult {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const { jobId, merged } = input;
  const pool = input.pool ?? null;
  const repo = input.repo ?? null;
  const ciWallMs = input.ciWallMs ?? null;
  const costUsd = input.costUsd ?? null;
  const dispatchedAt = canonicalTimestamp(input.dispatchedAt);
  const mergedAt = input.mergedAt === undefined || input.mergedAt === null
    ? null : canonicalTimestamp(input.mergedAt);
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId) ||
    (pool !== null && !POOL.test(pool)) || (repo !== null && !REPO.test(repo)) ||
    dispatchedAt === null || Date.parse(dispatchedAt) > Date.parse(now) + FUTURE_SKEW_MS ||
    (input.mergedAt !== undefined && input.mergedAt !== null && mergedAt === null) ||
    merged !== (mergedAt !== null) ||
    (mergedAt !== null && (Date.parse(mergedAt) < Date.parse(dispatchedAt) ||
      Date.parse(mergedAt) > Date.parse(now) + FUTURE_SKEW_MS)) ||
    (ciWallMs !== null && !isNonnegative(ciWallMs)) || (costUsd !== null && !isNonnegative(costUsd))) {
    throw new Error('Invalid reward signal');
  }
  for (const [value, field] of [[jobId, 'jobId'], [pool, 'pool'], [repo, 'repo']] as const) {
    if (value !== null) assertCleanToken(value, field);
  }
  const meterPool = options.usagePool === undefined ? pool : options.usagePool;
  if (meterPool !== null && !POOL.test(meterPool)) throw new Error('Invalid reward signal');
  const readings = options.usageReadings ?? (options.usageLogPath ? readUsageLog(options.usageLogPath) : []);
  const cost = meterPool !== null && readings.length
    ? usageCostFromReadings(readings, meterPool, Date.parse(dispatchedAt), Date.parse(now), costUsd)
    : { pool: meterPool, pctUsedStart: null, pctUsedEnd: null, pctUsedDelta: null, costUsd };
  const row: RewardSignalV1 = {
    v: REWARD_SIGNAL_SCHEMA, jobId, pool, repo, merged,
    dispatchedAt, mergedAt,
    timeToMergeMs: mergedAt === null ? null : Date.parse(mergedAt) - Date.parse(dispatchedAt),
    ciWallMs, cost, recordedAt: now,
  };
  if (!isRewardSignalV1(row)) throw new Error('Invalid reward signal');
  const path = options.path ?? rewardSignalPath();
  if (!isAbsolute(path)) throw new Error('Invalid reward signal path');
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const lock = acquireLocalStoreLock(join(directory, '.reward-signals.lock'), 2_000,
    { anchorPath: directory, exactPrivateStorage: true });
  if (!lock) throw new Error('Reward signal ledger is busy');
  try {
    for (const existing of readLedgerStrict(path)) {
      if (existing.jobId !== jobId) continue;
      if (sameOutcome(existing, row)) return { status: 'duplicate', row: existing };
      throw new Error('Conflicting reward signal for a recorded job');
    }
    if (!ownsLocalStoreLock(lock)) throw new Error('Reward signal lock lost');
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
      constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw new Error('Reward signal ledger is unsafe');
      }
      fchmodSync(fd, 0o600);
      const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
      if (stat.size + bytes.length > REWARD_SIGNAL_MAX_BYTES) {
        throw new Error('Reward signal ledger capacity reached');
      }
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('Reward signal write failed');
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDirectory(directory);
    return { status: 'recorded', row };
  } finally { releaseLocalStoreLock(lock); }
}

/** Minimal tolerant read of a usage-readings.log journal for cost metering. */
function readUsageLog(path: string): UsageReading[] {
  const file = readPrivateFileCapped(path, REWARD_SIGNAL_MAX_BYTES);
  if (!file) return [];
  if (file.truncated) throw new Error('Usage readings log exceeds the read bound');
  return file.text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line) as UsageReading;
      return row && typeof row === 'object' && typeof row.pool === 'string' ? [row] : [];
    } catch { return []; }
  });
}
