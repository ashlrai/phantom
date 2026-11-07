import { jobCurrentBatch, type JobCurrentBatchReport } from './job-current-batch.js';
import type { JobCurrentReport, JobTreeEntry } from './job-current.js';
import { validJobId } from './job-path-history.js';

/** Comparison payload version; bump on any shape change. */
export const JOB_COMPARE_SCHEMA = 1;

/** Injected seam: production uses jobCurrentBatch; tests pass a fixed batch. */
export type JobCompareReader = (ids: string[]) => Promise<JobCurrentBatchReport>;

/**
 * identical: both landed objects exist with the same mode, type and OID.
 * different: one or both landed objects differ, or only one side left one.
 * both-absent: both commits left no object here (a shared landed deletion).
 */
export type JobCompareStatus = 'identical' | 'different' | 'both-absent';

export interface JobCompareEntry {
  path: string;
  status: JobCompareStatus;
  /** The first job's landed entry at its own newest matching commit. */
  atFirst: JobTreeEntry | null;
  /** The second job's landed entry at its own newest matching commit. */
  atSecond: JobTreeEntry | null;
}

export interface JobCompareSide {
  jobId: string;
  matched: boolean;
  commit: JobCurrentReport['commit'];
  matchesTruncated: boolean;
  pathBound: number;
  omittedPaths: number;
  comparedPaths: number;
  /** jobCurrent's landed-vs-master summary, reported as context only. */
  currentSummary: JobCurrentReport['summary'];
}

export interface JobCompareReport {
  schemaVersion: typeof JOB_COMPARE_SCHEMA;
  ref: string;
  resolvedRef: string;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  /** Both jobs have a matching bridge commit; false means nothing was compared. */
  comparable: boolean;
  /** Shared paths are exhaustive only when neither job's path list was truncated. */
  sharedPathsComplete: boolean;
  /** Input order, one entry per requested id. */
  jobs: JobCompareSide[];
  /** Requested ids with no matching bridge commit in this bounded scan. */
  unmatched: string[];
  totals: { shared: number; identical: number; different: number; bothAbsent: number };
  /** Shared literal paths only, sorted by path. */
  entries: JobCompareEntry[];
  caveat: string;
}

const CAVEAT = 'Landed objects at the newest matching bridge commit of each job, from one pinned origin/master snapshot, '
  + 'compared only at paths both bounded lists name. Absence from a bounded list never proves disjointness. '
  + 'Identical objects are not semantic equivalence, safety, correctness or merge authority.';

function sameTreeEntry(left: JobTreeEntry | null, right: JobTreeEntry | null): boolean {
  return left !== null && right !== null
    && left.mode === right.mode && left.type === right.type && left.oid === right.oid;
}

function side(report: JobCurrentReport, comparedPaths: number): JobCompareSide {
  return {
    jobId: report.jobId, matched: report.commit !== null, commit: report.commit,
    matchesTruncated: report.matchesTruncated, pathBound: report.pathBound, omittedPaths: report.omittedPaths,
    comparedPaths, currentSummary: report.summary,
  };
}

/**
 * Compare the landed side of two exact jobs at their newest matching bridge
 * commits. The batch reader is called exactly once for both ids, so both
 * reports share one pinned origin/master and one bounded log scan. Only paths
 * present in both per-job lists are compared; a job with no matching commit
 * is reported as unmatched and never as identical. Read-only: no fetch,
 * mutation or merge, and git failures propagate as thrown errors.
 */
export async function jobCompare(first: string, second: string, read: JobCompareReader = ids => jobCurrentBatch(ids)): Promise<JobCompareReport> {
  if (typeof first !== 'string' || typeof second !== 'string' || first === second
    || !validJobId(first) || !validJobId(second)) {
    throw new Error('invalid job compare arguments');
  }
  const batch = await read([first, second]);
  const reports = [first, second].map(id => {
    const report = batch.jobs.find(job => job.jobId === id);
    if (!report) throw new Error('job compare reader omitted a requested job');
    return report;
  }) as [JobCurrentReport, JobCurrentReport];
  const [a, b] = reports;
  const comparable = a.commit !== null && b.commit !== null;
  const entries: JobCompareEntry[] = [];
  if (comparable) {
    const atSecond = new Map(b.entries.map(entry => [entry.path, entry]));
    for (const left of a.entries) {
      const right = atSecond.get(left.path);
      if (!right) continue;
      const status: JobCompareStatus = left.atCommit === null && right.atCommit === null ? 'both-absent'
        : sameTreeEntry(left.atCommit, right.atCommit) ? 'identical' : 'different';
      entries.push({ path: left.path, status, atFirst: left.atCommit, atSecond: right.atCommit });
    }
    entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }
  const count = (status: JobCompareStatus) => entries.filter(entry => entry.status === status).length;
  return {
    schemaVersion: JOB_COMPARE_SCHEMA, ref: batch.ref, resolvedRef: batch.resolvedRef,
    scanBound: batch.scanBound, scanned: batch.scanned, scanMayBeTruncated: batch.scanMayBeTruncated,
    comparable, sharedPathsComplete: comparable && a.omittedPaths === 0 && b.omittedPaths === 0,
    jobs: [side(a, comparable ? a.entries.length : 0), side(b, comparable ? b.entries.length : 0)],
    unmatched: reports.filter(report => report.commit === null).map(report => report.jobId),
    totals: {
      shared: entries.length, identical: count('identical'), different: count('different'), bothAbsent: count('both-absent'),
    },
    entries,
    caveat: CAVEAT,
  };
}
