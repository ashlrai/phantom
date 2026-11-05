import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jobCompare, type JobCompareReport, type JobCompareReader } from './job-compare.js';
import { jobCurrentBatch } from './job-current-batch.js';
import { JOB_HISTORY_REF } from './job-history-batch.js';
import { validSnapshotOid } from './job-overlap-snapshot.js';
import { validJobId } from './job-path-history.js';

const exec = promisify(execFile);
type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

/** The exact argv jobCurrentBatch uses to resolve origin/master; only this call is pinned. */
const RESOLVE_ARGS = ['rev-parse', '--verify', `${JOB_HISTORY_REF}^{commit}`];

export interface JobCompareSnapshotReport extends Omit<JobCompareReport, 'ref'> {
  /** The immutable commit OID the caller pinned; every log, diff-tree and ls-tree read used this OID. */
  requestedSnapshot: string;
  /** Replay evidence, not a live reading: origin/master may have moved on since this snapshot. */
  caveat: string;
}

const CAVEAT = 'Replayed from requestedSnapshot, which was verified as a commit and an ancestor of origin/master at request time. '
  + 'This is not current live origin/master: later pushes never change these findings. '
  + 'Landed objects at each job\'s newest matching bridge commit are compared only at paths both bounded lists name; '
  + 'absence from a bounded list never proves disjointness, and an unmatched job is never identical. '
  + 'Identical objects are not semantic equivalence, safety, correctness or merge authority.';

/**
 * Replays jobCompare at one recorded commit so a recut planner can reproduce a
 * landed-jobs comparison after master advances, instead of redoing the work
 * from shifted evidence. The OID must be a full lowercase 40- or 64-character
 * commit OID that is an ancestor of origin/master, checked with argument-array
 * git calls before any scan. jobCompare's injected batch reader is served by
 * jobCurrentBatch through a runner that answers origin/master's own resolution
 * from the pin — jobCurrentBatchSnapshot's report cannot fill the reader seam
 * because it drops `ref` — so the single bounded log scan, both diff-tree path
 * reads and every ls-tree object read observe exactly the recorded state no
 * matter how far master moves. Read-only: never fetches, never writes git
 * state, never scans a second history and never takes a filesystem root.
 */
export async function jobCompareSnapshot(snapshot: string, first: string, second: string, run: Git = git): Promise<JobCompareSnapshotReport> {
  if (!validSnapshotOid(snapshot) || typeof first !== 'string' || typeof second !== 'string'
    || first === second || !validJobId(first) || !validJobId(second)) {
    throw new Error('invalid job compare snapshot arguments');
  }
  if ((await run(['cat-file', '-t', snapshot])).trim() !== 'commit') throw new Error('job compare snapshot is not a commit');
  try {
    await run(['merge-base', '--is-ancestor', snapshot, JOB_HISTORY_REF]);
  } catch {
    throw new Error('job compare snapshot is not an ancestor of origin/master');
  }
  const pinned: Git = args => JSON.stringify(args) === JSON.stringify(RESOLVE_ARGS) ? Promise.resolve(`${snapshot}\n`) : run(args);
  const read: JobCompareReader = ids => jobCurrentBatch(ids, pinned);
  const { ref: _ref, ...report } = await jobCompare(first, second, read);
  return { ...report, requestedSnapshot: snapshot, caveat: CAVEAT };
}
