import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_JOBS = 100_000;
const OUTCOMES = ['queued', 'running', 'merged', 'empty', 'failed', 'cancelled'] as const;
type Outcome = typeof OUTCOMES[number];
interface Job {
  id: string;
  lane: string;
  tier: string;
  outcome?: Outcome;
  tokens?: number;
  startedAt?: number;
  mergedAt?: number;
  pr?: string;
  reverted?: boolean;
  impact?: number;
}

export interface MetricsRollup {
  jobs: number;
  completedJobs: number;
  incompleteJobs: number;
  mergedPRs: number;
  emptyJobs: number;
  revertedPRs: number;
  tokenSamples: number;
  timeToMergeSamples: number;
  revertSamples: number;
  impactSamples: number;
  knownTokens: number;
  mergeRate: number | null;
  emptyJobRate: number | null;
  tokensPerMergedPR: number | null;
  timeToMergeMs: number | null;
  revertRate: number | null;
  mergedImpactPerToken: number | null;
}

export interface MetricsGroup extends MetricsRollup { key: string }
export interface MetricsPrior {
  key: string;
  completedJobs: number;
  mergedPRs: number;
  emptyJobs: number;
  /** Null means unknown, not a zero-reward arm. */
  mergedImpactPerToken: number | null;
}
export interface MetricsFeed {
  schemaVersion: 1;
  kind: 'router-metrics';
  readOnly: true;
  sources: { jobsSha256: string; statusSha256: string };
  overall: MetricsRollup;
  lanes: MetricsGroup[];
  tiers: MetricsGroup[];
  laneTiers: Array<MetricsRollup & { lane: string; tier: string }>;
  priors: {
    basis: 'local-observations';
    operationalSteering: false;
    objective: 'mergedImpactPerToken';
    lanes: MetricsPrior[];
    tiers: MetricsPrior[];
  };
}

/** Only controlled diagnostics leave this module; never echo input records. */
export class MetricsInputError extends Error {}
function refuse(message: string): never { throw new MetricsInputError(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return refuse('Invalid JSON input.'); }
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) refuse('Invalid job, lane or tier identifier.');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) refuse('Invalid nonnegative numeric measurement.');
  return value;
}
function timestamp(value: unknown): number {
  // Canonical UTC instants avoid locale parsing and normalized invalid dates.
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) refuse('Timestamps must be canonical UTC ISO instants.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) refuse('Invalid timestamp.');
  return time;
}
function fields(row: Record<string, unknown>): Partial<Job> {
  const result: Partial<Job> = {};
  if (row.outcome !== undefined) {
    if (!OUTCOMES.includes(row.outcome as Outcome)) refuse('Invalid job outcome.');
    result.outcome = row.outcome as Outcome;
  }
  if (row.tokens !== undefined) {
    result.tokens = number(row.tokens);
    if (!Number.isSafeInteger(result.tokens)) refuse('Tokens must be a safe integer.');
  }
  if (row.impact !== undefined) result.impact = number(row.impact);
  if (row.startedAt !== undefined) result.startedAt = timestamp(row.startedAt);
  if (row.mergedAt !== undefined) result.mergedAt = timestamp(row.mergedAt);
  if (row.reverted !== undefined) {
    if (typeof row.reverted !== 'boolean') refuse('Reverted must be a boolean.');
    result.reverted = row.reverted;
  }
  if (row.pr !== undefined) {
    if (typeof row.pr !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#[1-9]\d*$/.test(row.pr) || row.pr.length > 256) refuse('PR must be owner/repository#number.');
    result.pr = row.pr.toLowerCase();
  }
  return result;
}
const complete = (job: Job): boolean => job.outcome !== undefined && !['queued', 'running'].includes(job.outcome);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function sum(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) refuse('Measurement total exceeds safe numeric range.');
  return total;
}
function rollup(jobs: Job[]): MetricsRollup {
  const done = jobs.filter(complete);
  const merged = done.filter(j => j.outcome === 'merged');
  const emptyJobs = done.filter(j => j.outcome === 'empty').length;
  const tokenSamples = done.filter(j => j.tokens !== undefined).length;
  const knownTokens = sum(done.map(j => j.tokens ?? 0));
  const durations = merged.filter(j => j.startedAt !== undefined && j.mergedAt !== undefined)
    .map(j => j.mergedAt! - j.startedAt!);
  const revertSamples = merged.filter(j => j.reverted !== undefined).length;
  const revertedPRs = merged.filter(j => j.reverted === true).length;
  // Reverted merges have known zero retained impact even without an impact score.
  const impacts = merged.filter(j => j.reverted === true || j.reverted === false && j.impact !== undefined)
    .map(j => j.reverted ? 0 : j.impact!);
  const tokensComplete = tokenSamples === done.length;
  return {
    jobs: jobs.length, completedJobs: done.length, incompleteJobs: jobs.length - done.length,
    mergedPRs: merged.length, emptyJobs, revertedPRs, tokenSamples,
    timeToMergeSamples: durations.length, revertSamples, impactSamples: impacts.length, knownTokens,
    mergeRate: done.length ? merged.length / done.length : null,
    emptyJobRate: done.length ? emptyJobs / done.length : null,
    tokensPerMergedPR: tokensComplete && merged.length ? knownTokens / merged.length : null,
    timeToMergeMs: merged.length && durations.length === merged.length ? sum(durations) / merged.length : null,
    revertRate: merged.length && revertSamples === merged.length ? revertedPRs / merged.length : null,
    mergedImpactPerToken: tokensComplete && knownTokens > 0 && impacts.length === merged.length ? sum(impacts) / knownTokens : null,
  };
}

/** Pure, deterministic conversion. No clock, network, persistence or dispatch. */
export function parseMetricsFeed(jobsText: string, statusText: string): MetricsFeed {
  if (Buffer.byteLength(jobsText) > MAX_BYTES || Buffer.byteLength(statusText) > MAX_BYTES) refuse('Metrics input exceeds 16 MiB.');
  // The shared stable reader replaces invalid UTF-8. Refuse replacement
  // characters (including literal U+FFFD) so source digests bind exact bytes.
  if (jobsText.includes('\uFFFD') || statusText.includes('\uFFFD')) refuse('Metrics input must be UTF-8 without replacement characters.');
  const jobs = new Map<string, Job>();
  for (const line of jobsText.split('\n')) {
    if (!line.trim()) continue;
    const row = object(parse(line));
    if (row.schemaVersion !== 1) refuse('Unsupported job schema version.');
    const id = identifier(row.id);
    if (jobs.has(id)) refuse('Duplicate job identifier.');
    jobs.set(id, { id, lane: identifier(row.lane), tier: identifier(row.tier), ...fields(row) });
    if (jobs.size > MAX_JOBS) refuse('Too many jobs.');
  }
  const status = object(parse(statusText));
  if (status.schemaVersion !== 1 || !Array.isArray(status.jobs)) refuse('Unsupported status schema.');
  if (status.jobsSha256 !== hash(jobsText)) refuse('Status snapshot does not match jobs bytes.');
  if (status.jobs.length > MAX_JOBS) refuse('Too many status entries.');
  const seen = new Set<string>();
  for (const entry of status.jobs) {
    const row = object(entry), id = identifier(row.id), old = jobs.get(id);
    if (seen.has(id) || !old) refuse('Duplicate or unknown status job.');
    seen.add(id);
    if (row.lane !== undefined && row.lane !== old.lane || row.tier !== undefined && row.tier !== old.tier) refuse('Status cannot change lane or tier.');
    const update = fields(row);
    if (complete(old) && update.outcome !== undefined && update.outcome !== old.outcome) refuse('Status cannot change a terminal outcome.');
    if (old.pr !== undefined && update.pr !== undefined && old.pr !== update.pr) refuse('Status cannot change PR identity.');
    if (old.reverted === true && update.reverted === false) refuse('Status cannot undo a recorded revert.');
    jobs.set(id, { ...old, ...update });
  }
  const prs = new Set<string>();
  const rows = [...jobs.values()].sort((a, b) => compare(a.id, b.id));
  for (const job of rows) {
    if (job.startedAt !== undefined && job.mergedAt !== undefined && job.mergedAt < job.startedAt) refuse('Merge precedes job start.');
    if (job.outcome === 'merged') {
      if (!job.pr || prs.has(job.pr)) refuse('Merged jobs require distinct PR identities.');
      prs.add(job.pr);
    } else if (job.mergedAt !== undefined || job.reverted !== undefined || job.impact !== undefined) {
      refuse('Merge evidence requires a merged outcome.');
    }
  }
  const groups = (field: 'lane' | 'tier'): MetricsGroup[] => {
    const grouped = new Map<string, Job[]>();
    for (const row of rows) {
      const group = grouped.get(row[field]) ?? [];
      group.push(row); grouped.set(row[field], group);
    }
    return [...grouped].sort(([a], [b]) => compare(a, b)).map(([key, group]) => ({ key, ...rollup(group) }));
  };
  const pairs = new Map<string, Job[]>();
  for (const row of rows) {
    const key = `${row.lane}/${row.tier}`, group = pairs.get(key) ?? [];
    group.push(row); pairs.set(key, group);
  }
  const lanes = groups('lane'), tiers = groups('tier');
  const priors = (groups: MetricsGroup[]): MetricsPrior[] => groups.map(({ key, completedJobs, mergedPRs, emptyJobs, mergedImpactPerToken }) =>
    ({ key, completedJobs, mergedPRs, emptyJobs, mergedImpactPerToken }));
  return {
    schemaVersion: 1, kind: 'router-metrics', readOnly: true,
    sources: { jobsSha256: hash(jobsText), statusSha256: hash(statusText) },
    overall: rollup(rows), lanes, tiers,
    laneTiers: [...pairs].sort(([a], [b]) => compare(a, b)).map(([, group]) => ({ lane: group[0].lane, tier: group[0].tier, ...rollup(group) })),
    priors: { basis: 'local-observations', operationalSteering: false, objective: 'mergedImpactPerToken', lanes: priors(lanes), tiers: priors(tiers) },
  };
}

function readLocal(path: string): string {
  // Refuse URIs and network share syntax before resolution. No implicit home lookup.
  if (!path || path.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) || /^(?:\/\/|\\\\)/.test(path)) refuse('Only local filesystem paths are accepted.');
  const absolute = resolve(path);
  const result = readStableRegularFile(absolute, { anchorPath: dirname(absolute), maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!result.ok) refuse('Metrics file is unreadable, unsafe, changed or oversized.');
  return result.text;
}

/** Reads only two explicit, owner-controlled regular files. Creates nothing. */
export function ingestMetrics(jobsPath: string, statusPath: string): MetricsFeed {
  return parseMetricsFeed(readLocal(jobsPath), readLocal(statusPath));
}
