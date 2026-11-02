/** Canonical dispatch-neutral queue contract. No executor or publication authority. */
export const QUEUE_STATUSES = ['READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'PROPOSED', 'SPLIT-PARENT', 'FIXUP', 'LAND', 'DONE', 'RETIRED', 'DROPPED'] as const;
export type QueueStatus = typeof QUEUE_STATUSES[number];
export interface QueueClaim { owner: string; claimedAt: string; finishedAt?: string }
export interface QueueJob {
  id: string;
  status: QueueStatus;
  priority: string;
  pool: string;
  tier: string;
  repo: string;
  deps: string[];
  scope: string;
  acceptance: string;
  claims: QueueClaim[];
  prUrl?: string;
  blockedReason?: string;
}
/** A job-shaped line that could not be parsed; retained verbatim instead of failing the import. */
export interface QueueRawLine { line: number; text: string; warning: string }
export interface QueueDocument {
  schema: 'queue.v1';
  jobs: QueueJob[];
  /** Unparsed job-shaped lines from Markdown import, one-based line number and reason. */
  raw?: QueueRawLine[];
  /** Non-fatal import observations (unknown statuses, dropped self-deps, unbalanced parens). */
  warnings?: string[];
  /** Original lines, including terminators, retain comments and unknown router fields. */
  source?: { text: string; jobs: QueueJob[] };
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const timestamp = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
export function validateQueue(value: unknown): asserts value is QueueDocument {
  if (!record(value) || value.schema !== 'queue.v1' || !Array.isArray(value.jobs)) throw new Error('Expected queue.v1 document');
  const ids = new Set<string>();
  for (const job of value.jobs) {
    if (!record(job) || !nonempty(job.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(job.id)) throw new Error('Invalid job id');
    if (ids.has(job.id)) throw new Error(`Duplicate job: ${job.id}`);
    ids.add(job.id);
    if (!QUEUE_STATUSES.includes(job.status as QueueStatus)) throw new Error(`Invalid status: ${job.id}`);
    for (const key of ['priority', 'pool', 'tier', 'repo', 'scope']) if (!nonempty(job[key])) throw new Error(`Missing ${key}: ${job.id}`);
    if (typeof job.acceptance !== 'string') throw new Error(`Invalid acceptance: ${job.id}`);
    if (!Array.isArray(job.deps) || job.deps.some(d => !nonempty(d) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d) || d === job.id) || new Set(job.deps).size !== job.deps.length) throw new Error(`Invalid deps: ${job.id}`);
    if (!Array.isArray(job.claims) || job.claims.some(c => !record(c) || !nonempty(c.owner) || !timestamp(c.claimedAt) || (c.finishedAt !== undefined && (!timestamp(c.finishedAt) || Date.parse(c.finishedAt as string) < Date.parse(c.claimedAt as string))))) throw new Error(`Invalid claims: ${job.id}`);
    if (job.prUrl !== undefined) {
      if (typeof job.prUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(job.prUrl)) throw new Error(`Invalid PR URL: ${job.id}`);
      const url = new URL(job.prUrl);
      if (url.username || url.password) throw new Error('PR URL must not contain credentials');
    }
    if (job.blockedReason !== undefined && !nonempty(job.blockedReason)) throw new Error(`Invalid block reason: ${job.id}`);
  }
  if (value.raw !== undefined) {
    if (!Array.isArray(value.raw)) throw new Error('Invalid raw records');
    for (const entry of value.raw) {
      if (!record(entry) || !Number.isInteger(entry.line) || (entry.line as number) < 1 || !nonempty(entry.text) || !nonempty(entry.warning)) throw new Error('Invalid raw record');
    }
  }
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.some(w => !nonempty(w)))) throw new Error('Invalid warnings');
  if (value.source !== undefined) {
    if (!record(value.source) || typeof value.source.text !== 'string') throw new Error('Invalid queue source');
    validateQueue({ schema: 'queue.v1', jobs: value.source.jobs });
  }
}
