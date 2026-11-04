import { JOB_BATCH_MAX, JOB_HISTORY_REF, jobHistoryBatch } from './job-history-batch.js';
import { JOB_LIMIT_MAX, validJobId } from './job-path-history.js';

/** A batch smaller than this cannot overlap with itself. */
export const JOB_OVERLAP_MIN_IDS = 2;

type Git = (args: string[]) => Promise<string>;

export interface JobOverlapJob {
  jobId: string;
  /** Kept matching bridge commits inside the bounded scan (at most `limit`). */
  commits: number;
  /** Distinct literal repo paths those kept commits touched. */
  paths: number;
  /** More bridge commits matched than `limit` kept — this id's path list is a floor, not a ceiling. */
  matchesTruncated: boolean;
}

export interface JobOverlapResult {
  schemaVersion: 1;
  ref: string;
  resolvedRef: string;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  limit: number;
  /** True when the scan hit its bound or any id's matches exceeded `limit` — recorded paths may be missing. */
  evidenceMayBeIncomplete: boolean;
  /** Per requested id, in input order. */
  jobs: JobOverlapJob[];
  /** Literal paths touched by at least two distinct requested ids; sorted, ids in input order. */
  sharedPaths: Array<{ path: string; jobIds: string[] }>;
  note: string;
}

const NOTE = 'Literal paths on landed bridge commits only — queued claims, in-flight worktrees and prospective diffs are never compared. '
  + 'An empty sharedPaths means no overlap was observed inside this bounded history; it is never proof of safety or permission to dispatch.';

/**
 * Which of the requested job ids touched the same exact repo paths, answered
 * from ONE jobHistoryBatch call so a planner pays a single bounded scan per
 * proposed batch. Paths are compared literally — case and punctuation are
 * preserved, never normalized — and a path reaches sharedPaths only when at
 * least two distinct requested ids each landed a bridge commit touching it.
 * An absent id contributes no paths and can never fabricate a group.
 */
export async function jobOverlap(jobIds: string[], limit: number, run?: Git): Promise<JobOverlapResult> {
  if (!Array.isArray(jobIds) || jobIds.length < JOB_OVERLAP_MIN_IDS || jobIds.length > JOB_BATCH_MAX
    || !Number.isInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX
    || new Set(jobIds).size !== jobIds.length
    || !jobIds.every(id => typeof id === 'string' && validJobId(id))) {
    throw new Error('invalid job overlap arguments');
  }
  const batch = await jobHistoryBatch(jobIds, limit, run);
  const byPath = new Map<string, string[]>();
  for (const job of batch.jobs) {
    for (const path of job.paths) {
      const hit = byPath.get(path);
      if (hit) hit.push(job.jobId);
      else byPath.set(path, [job.jobId]);
    }
  }
  const sharedPaths = [...byPath.keys()].sort()
    .filter(path => byPath.get(path)!.length > 1)
    .map(path => ({ path, jobIds: byPath.get(path)! }));
  const jobs = batch.jobs.map(job => ({
    jobId: job.jobId, commits: job.commits.length, paths: job.paths.length,
    matchesTruncated: job.matchesTruncated,
  }));
  return {
    schemaVersion: 1,
    ref: JOB_HISTORY_REF,
    resolvedRef: batch.resolvedRef,
    scanBound: batch.scanBound,
    scanned: batch.scanned,
    scanMayBeTruncated: batch.scanMayBeTruncated,
    limit: batch.limit,
    evidenceMayBeIncomplete: batch.scanMayBeTruncated || jobs.some(job => job.matchesTruncated),
    jobs,
    sharedPaths,
    note: NOTE,
  };
}
