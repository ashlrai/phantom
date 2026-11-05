import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jobCurrentBatch, type JobCurrentBatchReport } from './job-current-batch.js';
import { JOB_BATCH_MAX, JOB_HISTORY_REF } from './job-history-batch.js';
import { validSnapshotOid } from './job-overlap-snapshot.js';
import { validJobId } from './job-path-history.js';

const exec = promisify(execFile);
type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;
const resolveArgs = ['rev-parse', '--verify', `${JOB_HISTORY_REF}^{commit}`];

export interface JobCurrentBatchSnapshotReport extends Omit<JobCurrentBatchReport, 'ref'> {
  requestedSnapshot: string;
  caveat: string;
}

/** Replay a bounded batch at a verified ancestor, with no fetches or writes. */
export async function jobCurrentBatchSnapshot(snapshot: string, jobIds: string[], run: Git = git): Promise<JobCurrentBatchSnapshotReport> {
  if (typeof snapshot !== 'string' || !validSnapshotOid(snapshot) || !Array.isArray(jobIds)
    || jobIds.length < 1 || jobIds.length > JOB_BATCH_MAX || new Set(jobIds).size !== jobIds.length
    || !jobIds.every(id => typeof id === 'string' && validJobId(id))) {
    throw new Error('invalid job current batch snapshot arguments');
  }
  if ((await run(['cat-file', '-t', snapshot])).trim() !== 'commit') throw new Error('job current batch snapshot is not a commit');
  try { await run(['merge-base', '--is-ancestor', snapshot, JOB_HISTORY_REF]); }
  catch { throw new Error('job current batch snapshot is not an ancestor of origin/master'); }
  const pinned: Git = args => JSON.stringify(args) === JSON.stringify(resolveArgs) ? Promise.resolve(`${snapshot}\n`) : run(args);
  const { ref: _ref, ...report } = await jobCurrentBatch(jobIds, pinned);
  return { ...report, requestedSnapshot: snapshot,
    caveat: 'Replay at the requested snapshot, verified as a commit and ancestor of origin/master at request time; it is not current origin/master. Missing matches are bounded evidence, not proof a job never landed. Object identity is not behavioral correctness; absent-at-both does not mean missing work.' };
}
