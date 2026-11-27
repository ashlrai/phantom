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
  /** Tier ceiling: spare capacity never runs the job above it. */
  max_tier?: 'fast' | 'mid' | 'work' | 'frontier';
  max_cost_class?: 'local' | 'included' | 'metered';
  /** Data handling class. An executor needs at least this clearance. */
  data_class?: 'public' | 'internal' | 'confidential' | 'restricted';
  /** Declared kind of work; ranks resources, never excludes one. */
  work_class?: 'bulk' | 'standard' | 'judgment';
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
export const QUEUE_TIERS = ['fast', 'mid', 'work', 'frontier'] as const;
export const QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const QUEUE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Canonical `metrics/jobs.jsonl` field-dialect key lists shared across queue readers. */
export const LEDGER_JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
export const LEDGER_EVENT_KEYS = ['event', 'type', 'kind'] as const;
export const LEDGER_PHASE_KEYS = ['state', 'outcome', 'status', 'phase', 'result', 'conclusion'] as const;
export const LEDGER_TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;

export const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
export const nonEmptyString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
export const isNonNegativeFinite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;
export const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const isIsoTimestamp = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
/** Parse a Unix-seconds number or ISO timestamp string into epoch ms, or NaN. */
export const parseEpochOrIsoMs = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v * 1000
    : typeof v === 'string' ? Date.parse(v) : NaN;
export const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
export const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const compareLexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function pickTrimmedString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(row[key]);
    if (value !== null) return value;
  }
  return null;
}

const READY_LINE_ID = /^- READY\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/;
const READY_LINE_ENQ = /(?:^|[\s,(])enq=(\d+)(?=$|[\s,)])/;

/** Parse a `- READY <id>` router-queue line's job id and optional `enq=<epoch-seconds>` stamp in ms. */
export function parseReadyLineEnq(line: string): { id: string; enqueuedAtMs: number | null } | null {
  const match = READY_LINE_ID.exec(line);
  if (!match) return null;
  const token = READY_LINE_ENQ.exec(line);
  return { id: match[1]!, enqueuedAtMs: token ? Number(token[1]) * 1000 : null };
}

const TIER_ORDER: readonly string[] = QUEUE_TIERS;
export function validateQueue(value: unknown): asserts value is QueueDocument {
  if (!isPlainRecord(value) || value.schema !== 'queue.v1' || !Array.isArray(value.jobs)) throw new Error('Expected queue.v1 document');
  const ids = new Set<string>();
  for (const job of value.jobs) {
    if (!isPlainRecord(job) || !isNonEmptyString(job.id) || !QUEUE_ID_PATTERN.test(job.id)) throw new Error('Invalid job id');
    if (ids.has(job.id)) throw new Error(`Duplicate job: ${job.id}`);
    ids.add(job.id);
    if (!QUEUE_STATUSES.includes(job.status as QueueStatus)) throw new Error(`Invalid status: ${job.id}`);
    for (const key of ['priority', 'tier', 'repo', 'scope']) if (!isNonEmptyString(job[key])) throw new Error(`Missing ${key}: ${job.id}`);
    if (job.pool !== undefined && !isNonEmptyString(job.pool)) throw new Error(`Invalid pool: ${job.id}`);
    if (job.preferred_lane !== undefined && (typeof job.preferred_lane !== 'string' || !/^[a-z][a-z0-9-]*$/.test(job.preferred_lane))) throw new Error(`Invalid preferred_lane: ${job.id}`);
    if (job.needs !== undefined && (!Array.isArray(job.needs) || job.needs.some(n => typeof n !== 'string' || !/^(?:[a-z][a-z0-9-]*|secrets:[A-Za-z0-9_.-]+)$/.test(n)))) throw new Error(`Invalid needs: ${job.id}`);
    if (job.min_tier !== undefined && !TIER_ORDER.includes(job.min_tier as string)) throw new Error(`Invalid min_tier: ${job.id}`);
    if (job.max_tier !== undefined && !TIER_ORDER.includes(job.max_tier as string)) throw new Error(`Invalid max_tier: ${job.id}`);
    if (job.max_tier !== undefined && TIER_ORDER.includes(job.tier as string) && TIER_ORDER.indexOf(job.tier as string) > TIER_ORDER.indexOf(job.max_tier as string)) throw new Error(`tier above max_tier: ${job.id}`);
    if (job.min_tier !== undefined && job.max_tier !== undefined && TIER_ORDER.indexOf(job.min_tier as string) > TIER_ORDER.indexOf(job.max_tier as string)) throw new Error(`min_tier above max_tier: ${job.id}`);
    if (job.max_cost_class !== undefined && !['local', 'included', 'metered'].includes(job.max_cost_class as string)) throw new Error(`Invalid max_cost_class: ${job.id}`);
    if (job.data_class !== undefined && !['public', 'internal', 'confidential', 'restricted'].includes(job.data_class as string)) throw new Error(`Invalid data_class: ${job.id}`);
    if (job.work_class !== undefined && !['bulk', 'standard', 'judgment'].includes(job.work_class as string)) throw new Error(`Invalid work_class: ${job.id}`);
    if (job.exclusive !== undefined && typeof job.exclusive !== 'boolean') throw new Error(`Invalid exclusive: ${job.id}`);
    if (job.impact !== undefined && (typeof job.impact !== 'number' || !Number.isFinite(job.impact))) throw new Error(`Invalid impact: ${job.id}`);
    if (typeof job.acceptance !== 'string') throw new Error(`Invalid acceptance: ${job.id}`);
    if (!Array.isArray(job.deps) || job.deps.some(d => !isNonEmptyString(d) || !QUEUE_ID_PATTERN.test(d) || d === job.id) || new Set(job.deps).size !== job.deps.length) throw new Error(`Invalid deps: ${job.id}`);
    if (!Array.isArray(job.claims) || job.claims.some(c => !isPlainRecord(c) || !isNonEmptyString(c.owner) || !isIsoTimestamp(c.claimedAt) || (c.finishedAt !== undefined && (!isIsoTimestamp(c.finishedAt) || Date.parse(c.finishedAt) < Date.parse(c.claimedAt))))) throw new Error(`Invalid claims: ${job.id}`);
    if (job.replayOf !== undefined && (!isNonEmptyString(job.replayOf) || job.replayOf === job.id || !isIsoTimestamp(job.replayedAt))) throw new Error(`Invalid replay lineage: ${job.id}`);
    if (job.prUrl !== undefined) {
      if (typeof job.prUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(job.prUrl)) throw new Error(`Invalid PR URL: ${job.id}`);
      const url = new URL(job.prUrl);
      if (url.username || url.password) throw new Error('PR URL must not contain credentials');
    }
    if (job.blockedReason !== undefined && !isNonEmptyString(job.blockedReason)) throw new Error(`Invalid block reason: ${job.id}`);
    if (job.parent !== undefined && (!isNonEmptyString(job.parent) || !QUEUE_ID_PATTERN.test(job.parent) || job.parent === job.id)) throw new Error(`Invalid parent: ${job.id}`);
    if (job.depth !== undefined && (!isNonNegativeInt(job.depth) || job.depth > 64)) throw new Error(`Invalid depth: ${job.id}`);
  }
  if (value.raw !== undefined) {
    if (!Array.isArray(value.raw)) throw new Error('Invalid raw records');
    for (const entry of value.raw) {
      if (!isPlainRecord(entry) || !Number.isInteger(entry.line) || (entry.line as number) < 1 || !isNonEmptyString(entry.text) || !isNonEmptyString(entry.warning)) throw new Error('Invalid raw record');
    }
  }
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.some(w => !isNonEmptyString(w)))) throw new Error('Invalid warnings');
  if (value.source !== undefined) {
    if (!isPlainRecord(value.source) || typeof value.source.text !== 'string') throw new Error('Invalid queue source');
    validateQueue({ schema: 'queue.v1', jobs: value.source.jobs });
  }
}
