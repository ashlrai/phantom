/** Canonical dispatch-neutral queue contract. No executor or publication authority. */
export const QUEUE_STATUSES = ['READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'PROPOSED', 'SPLIT-PARENT', 'FIXUP', 'LAND', 'DONE', 'RETIRED', 'DROPPED'] as const;
export type QueueStatus = typeof QUEUE_STATUSES[number];
export interface QueueClaim { owner: string; claimedAt: string; finishedAt?: string }
export interface QueueJob {
  id: string;
  status: QueueStatus;
  priority: string;
  pool?: string;
  /** Compatibility hint. Execution is selected only at dispatch. */
  preferred_lane?: string;
  needs?: string[];
  min_tier?: 'fast' | 'mid' | 'work' | 'frontier';
  max_cost_class?: 'local' | 'included' | 'metered';
  exclusive?: boolean;
  impact?: number;
  tier: string;
  repo: string;
  deps: string[];
  scope: string;
  acceptance: string;
  claims: QueueClaim[];
  replayOf?: string;
  replayedAt?: string;
  prUrl?: string;
  blockedReason?: string;
  parent?: string;
  depth?: number;
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
    for (const key of ['priority', 'tier', 'repo', 'scope']) if (!nonempty(job[key])) throw new Error(`Missing ${key}: ${job.id}`);
    if (job.pool !== undefined && !nonempty(job.pool)) throw new Error(`Invalid pool: ${job.id}`);
    if (job.preferred_lane !== undefined && (typeof job.preferred_lane !== 'string' || !/^[a-z][a-z0-9-]*$/.test(job.preferred_lane))) throw new Error(`Invalid preferred_lane: ${job.id}`);
    if (job.needs !== undefined && (!Array.isArray(job.needs) || job.needs.some(n => typeof n !== 'string' || !/^(?:[a-z][a-z0-9-]*|secrets:[A-Za-z0-9_.-]+)$/.test(n)))) throw new Error(`Invalid needs: ${job.id}`);
    if (job.min_tier !== undefined && !['fast', 'mid', 'work', 'frontier'].includes(job.min_tier as string)) throw new Error(`Invalid min_tier: ${job.id}`);
    if (job.max_cost_class !== undefined && !['local', 'included', 'metered'].includes(job.max_cost_class as string)) throw new Error(`Invalid max_cost_class: ${job.id}`);
    if (job.exclusive !== undefined && typeof job.exclusive !== 'boolean') throw new Error(`Invalid exclusive: ${job.id}`);
    if (job.impact !== undefined && (typeof job.impact !== 'number' || !Number.isFinite(job.impact))) throw new Error(`Invalid impact: ${job.id}`);
    if (typeof job.acceptance !== 'string') throw new Error(`Invalid acceptance: ${job.id}`);
    if (!Array.isArray(job.deps) || job.deps.some(d => !nonempty(d) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d) || d === job.id) || new Set(job.deps).size !== job.deps.length) throw new Error(`Invalid deps: ${job.id}`);
    if (!Array.isArray(job.claims) || job.claims.some(c => !record(c) || !nonempty(c.owner) || !timestamp(c.claimedAt) || (c.finishedAt !== undefined && (!timestamp(c.finishedAt) || Date.parse(c.finishedAt as string) < Date.parse(c.claimedAt as string))))) throw new Error(`Invalid claims: ${job.id}`);
    if (job.replayOf !== undefined && (!nonempty(job.replayOf) || job.replayOf === job.id || !timestamp(job.replayedAt))) throw new Error(`Invalid replay lineage: ${job.id}`);
    if (job.prUrl !== undefined) {
      if (typeof job.prUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(job.prUrl)) throw new Error(`Invalid PR URL: ${job.id}`);
      const url = new URL(job.prUrl);
      if (url.username || url.password) throw new Error('PR URL must not contain credentials');
    }
    if (job.blockedReason !== undefined && !nonempty(job.blockedReason)) throw new Error(`Invalid block reason: ${job.id}`);
    if (job.parent !== undefined && (!nonempty(job.parent) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(job.parent) || job.parent === job.id)) throw new Error(`Invalid parent: ${job.id}`);
    if (job.depth !== undefined && (!Number.isSafeInteger(job.depth) || (job.depth as number) < 0 || (job.depth as number) > 64)) throw new Error(`Invalid depth: ${job.id}`);
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
