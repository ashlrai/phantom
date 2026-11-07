/**
 * RQ-V4-ASK-FANOUT-1. Split one operator ask.v1 record into N queue.v1 jobs:
 * one repo each, N by tier (work 1, mid 2, frontier 3).
 *
 * Pure projection, like portfolio/rq-backlog: nothing here executes task text,
 * writes a queue, or grants authority. The caller supplies the configured repo
 * allowlist; a repository outside it never becomes a job. Job records add
 * `task` — the untrusted prompt data the serialized queue.v1 row carries after
 * the colon — on top of the documented scheduling fields (drive/queue-v1.ts).
 * Job identities are content-derived, so a replayed ask dedupes at the queue
 * store instead of multiplying work.
 */
import { createHash } from 'node:crypto';
import type { DriveQueueV1 } from '../drive/queue-v1.js';

/** Fanout breadth per ask tier: work 1, mid 2, frontier 3. */
export const ASK_FANOUT_N = Object.freeze({ work: 1, mid: 2, frontier: 3 } as const);
export type AskTier = keyof typeof ASK_FANOUT_N;

export const ASK_LIMITS = Object.freeze({ taskChars: 8_000, repos: 7 });

export interface AskV1 {
  schema: 'ask.v1';
  id: string;
  tier: AskTier;
  pool: string;
  priority: string;
  /** Candidate `ashlrai/name` repositories in the operator's preference order. */
  repos: string[];
  /** Untrusted task data, for a model prompt only. Never shell input. */
  task: string;
}

/** Documented queue.v1 scheduling tuple (drive/queue-v1.ts). */
export type QueueJobV1 = DriveQueueV1['jobs'][number];

/** queue.v1 job plus the task text its serialized row carries after the colon. */
export interface AskFanoutJobV1 extends QueueJobV1 {
  status: 'READY';
  tier: AskTier;
  task: string;
}

export interface AskFanoutQueueV1 extends DriveQueueV1 {
  jobs: AskFanoutJobV1[];
}

const REPO = /^ashlrai\/([a-z0-9][a-z0-9._-]{0,99})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const POOL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRIORITY = /^P[0-9]$/;
const KEYS = 'id,pool,priority,repos,schema,task,tier';

function invalid(message: string): never { throw new Error(`Invalid ask.v1: ${message}`); }

export function parseAskV1(value: unknown): AskV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected an object');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== KEYS) invalid('unexpected or missing fields');
  if (row['schema'] !== 'ask.v1') invalid('schema must be ask.v1');
  const id = row['id'];
  if (typeof id !== 'string' || !ID.test(id)) invalid('id');
  const tier = row['tier'];
  if (typeof tier !== 'string' || !(tier in ASK_FANOUT_N)) invalid('tier');
  const pool = row['pool'];
  if (typeof pool !== 'string' || !POOL.test(pool)) invalid('pool');
  const priority = row['priority'];
  if (typeof priority !== 'string' || !PRIORITY.test(priority)) invalid('priority');
  const repos = row['repos'];
  if (!Array.isArray(repos) || repos.length === 0 || repos.length > ASK_LIMITS.repos ||
    new Set(repos).size !== repos.length ||
    repos.some((name) => typeof name !== 'string' || !REPO.test(name))) invalid('repos');
  const task = row['task'];
  if (typeof task !== 'string' || !task.trim() || task.length > ASK_LIMITS.taskChars) invalid('task');
  for (const char of task) {
    const code = char.charCodeAt(0);
    if (code === 127 || (code < 32 && ![9, 10, 13].includes(code))) invalid('task control characters');
  }
  return { schema: 'ask.v1', id, tier: tier as AskTier, pool, priority, repos: repos as string[], task };
}

/**
 * Emit ASK_FANOUT_N[tier] READY jobs over the first N listed repos, one repo
 * per job. Every listed repo must be configured; a malformed or out-of-scope
 * ask fails whole, never partially.
 */
export function fanoutAskV1(ask: unknown, allowedRepos: ReadonlySet<string>): AskFanoutQueueV1 {
  const record = parseAskV1(ask);
  const n = ASK_FANOUT_N[record.tier];
  if (record.repos.length < n) invalid(`tier ${record.tier} requires ${n} repos, got ${record.repos.length}`);
  for (const name of record.repos) if (!allowedRepos.has(name)) invalid(`repo ${name} is not configured`);
  const jobs: AskFanoutJobV1[] = record.repos.slice(0, n).map((name) => ({
    id: `RQ-${createHash('sha256').update(`ask.v1\x00${record.id}\x00${name}`).digest('hex').slice(0, 24)}`,
    status: 'READY', priority: record.priority, pool: record.pool, tier: record.tier,
    repo: REPO.exec(name)![1]!, deps: [], task: record.task,
  }));
  return { schema: 'queue.v1', jobs };
}
