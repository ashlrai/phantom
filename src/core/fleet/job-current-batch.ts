import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jobCurrent, type JobCurrentReport } from './job-current.js';
import { JOB_BATCH_MAX, JOB_HISTORY_REF } from './job-history-batch.js';
import { validJobId } from './job-path-history.js';

const exec = promisify(execFile);
/** Batch payload version; bump on any shape change. */
export const JOB_CURRENT_BATCH_SCHEMA = 1;

type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

export interface JobCurrentBatchReport {
  schemaVersion: typeof JOB_CURRENT_BATCH_SCHEMA;
  ref: string;
  resolvedRef: string;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  /** One full jobCurrent report per requested id, in input order. */
  jobs: JobCurrentReport[];
  totals: {
    jobs: number;
    matched: number;
    unchanged: number;
    changed: number;
    absentNow: number;
    absentAtBoth: number;
    omittedPaths: number;
  };
}

/**
 * Audit up to JOB_BATCH_MAX distinct exact job ids against ONE immutable
 * origin/master snapshot, so a recut decision compares every candidate to the
 * same tree instead of mixing per-command resolutions. The movable ref is
 * resolved to a commit OID once; each id is then served by the existing
 * jobCurrent reader through an injected runner that answers the ref's
 * rev-parse with the pinned OID and memoizes identical read calls — the
 * bounded log scan is byte-identical for every id, so it costs one call for
 * the whole batch. Ids run sequentially, keeping concurrency at jobCurrent's
 * own bound, and per-job truncation and omitted-path evidence pass through
 * untouched. Missing commits and changed objects are evidence only, never
 * correctness or permission verdicts. Git failures propagate — evidence is
 * never fabricated. Read-only: no fetch, mutation or merge.
 */
export async function jobCurrentBatch(jobIds: string[], run: Git = git): Promise<JobCurrentBatchReport> {
  if (!Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > JOB_BATCH_MAX
    || new Set(jobIds).size !== jobIds.length
    || !jobIds.every(id => typeof id === 'string' && validJobId(id))) {
    throw new Error('invalid job current batch arguments');
  }
  const resolvedRef = (await run(['rev-parse', '--verify', `${JOB_HISTORY_REF}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(resolvedRef)) throw new Error(`unable to resolve ${JOB_HISTORY_REF}`);
  const memo = new Map<string, Promise<string>>();
  const pinned: Git = args => {
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === `${JOB_HISTORY_REF}^{commit}`) {
      return Promise.resolve(`${resolvedRef}\n`);
    }
    const key = JSON.stringify(args);
    let pending = memo.get(key);
    if (!pending) { pending = run(args); memo.set(key, pending); }
    return pending;
  };
  const jobs: JobCurrentReport[] = [];
  for (const id of jobIds) jobs.push(await jobCurrent(id, pinned));
  const totals = {
    jobs: jobs.length, matched: 0, unchanged: 0, changed: 0, absentNow: 0, absentAtBoth: 0, omittedPaths: 0,
  };
  for (const job of jobs) {
    if (job.commit) totals.matched++;
    totals.unchanged += job.summary.unchanged;
    totals.changed += job.summary.changed;
    totals.absentNow += job.summary.absentNow;
    totals.absentAtBoth += job.summary.absentAtBoth;
    totals.omittedPaths += job.omittedPaths;
  }
  // Every per-job report shares the memoized log scan, so jobs[0] speaks for all.
  return {
    schemaVersion: JOB_CURRENT_BATCH_SCHEMA, ref: JOB_HISTORY_REF, resolvedRef,
    scanBound: jobs[0]!.scanBound, scanned: jobs[0]!.scanned,
    scanMayBeTruncated: jobs[0]!.scanMayBeTruncated, jobs, totals,
  };
}
