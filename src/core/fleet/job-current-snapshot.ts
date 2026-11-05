import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JOB_HISTORY_REF } from './job-history-batch.js';
import { jobCurrent, type JobCurrentReport } from './job-current.js';
import { validSnapshotOid } from './job-overlap-snapshot.js';
import { validJobId } from './job-path-history.js';

const exec = promisify(execFile);
type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

/** The exact argv jobPathHistory uses to resolve origin/master; only this call is pinned. */
const RESOLVE_ARGS = ['rev-parse', '--verify', `${JOB_HISTORY_REF}^{commit}`];

export interface JobCurrentSnapshotReport extends Omit<JobCurrentReport, 'ref'> {
  /** The immutable commit OID the caller pinned; every log and ls-tree read used this OID. */
  requestedSnapshot: string;
  /** Replay evidence, not a live reading: origin/master may have moved on since this snapshot. */
  caveat: string;
}

const CAVEAT = 'Replayed from requestedSnapshot, which was verified as a commit and an ancestor of origin/master at request time. '
  + 'This is not current live origin/master: later pushes never change these findings. '
  + 'Object identity is not behavioral correctness; absent-at-both does not mean missing work.';

/**
 * Replays jobCurrent at one recorded commit so a recut planner can reproduce a
 * prior current-state audit after master advances. The OID must be a full
 * lowercase 40- or 64-character commit OID that is an ancestor of
 * origin/master, checked with argument-array git calls before any scan. The
 * only substitution is origin/master's own resolution, so the history scan
 * and both ls-tree reads (the matched bridge commit and the pinned tip)
 * observe exactly the recorded state no matter how far master moves.
 * Read-only: never fetches or writes.
 */
export async function jobCurrentSnapshot(snapshot: string, job: string, run: Git = git): Promise<JobCurrentSnapshotReport> {
  if (!validSnapshotOid(snapshot) || !validJobId(job)) throw new Error('invalid job current snapshot arguments');
  if ((await run(['cat-file', '-t', snapshot])).trim() !== 'commit') throw new Error('job current snapshot is not a commit');
  try {
    await run(['merge-base', '--is-ancestor', snapshot, JOB_HISTORY_REF]);
  } catch {
    throw new Error('job current snapshot is not an ancestor of origin/master');
  }
  const pinned: Git = async args => JSON.stringify(args) === JSON.stringify(RESOLVE_ARGS) ? `${snapshot}\n` : run(args);
  const { ref: _ref, ...report } = await jobCurrent(job, pinned);
  return { ...report, requestedSnapshot: snapshot, caveat: CAVEAT };
}
