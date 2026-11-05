import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JOB_BATCH_MAX, JOB_HISTORY_REF } from './job-history-batch.js';
import { JOB_OVERLAP_MIN_IDS, jobOverlap, type JobOverlapResult } from './job-overlap.js';
import { JOB_LIMIT_MAX, validJobId } from './job-path-history.js';

const exec = promisify(execFile);
type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

/** The exact argv jobHistoryBatch uses to resolve origin/master; only this call is pinned. */
const RESOLVE_ARGS = ['rev-parse', '--verify', `${JOB_HISTORY_REF}^{commit}`];

export interface JobOverlapSnapshotResult extends Omit<JobOverlapResult, 'ref'> {
  /** The immutable commit OID the caller pinned; every log and diff-tree read used this OID. */
  requestedSnapshot: string;
  /** Replay evidence, not a live reading: origin/master may have moved on since this snapshot. */
  caveat: string;
}

/** A full lowercase SHA-1 or SHA-256 object name only: no refs, ranges, abbreviations or uppercase. */
export function validSnapshotOid(oid: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid);
}

const CAVEAT = 'Replayed from requestedSnapshot, which was verified as a commit and an ancestor of origin/master at request time. '
  + 'This is not current live origin/master: later pushes never change these findings. '
  + 'Literal paths on landed bridge commits only; an empty sharedPaths is bounded evidence, never proof of safety.';

/**
 * Replays jobOverlap at one recorded commit. The OID must be a commit and an
 * ancestor of origin/master, checked with argument-array git calls before any
 * scan. The only substitution is origin/master's own resolution, so the
 * overlap scan reads exactly the same history no matter how far master moves.
 */
export async function jobOverlapSnapshot(snapshot: string, jobIds: string[], limit: number, run: Git = git): Promise<JobOverlapSnapshotResult> {
  if (!validSnapshotOid(snapshot) || !Array.isArray(jobIds)
    || jobIds.length < JOB_OVERLAP_MIN_IDS || jobIds.length > JOB_BATCH_MAX
    || new Set(jobIds).size !== jobIds.length || !jobIds.every(id => typeof id === 'string' && validJobId(id))
    || !Number.isInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX) {
    throw new Error('invalid job overlap snapshot arguments');
  }
  if ((await run(['cat-file', '-t', snapshot])).trim() !== 'commit') throw new Error('job overlap snapshot is not a commit');
  try {
    await run(['merge-base', '--is-ancestor', snapshot, JOB_HISTORY_REF]);
  } catch {
    throw new Error('job overlap snapshot is not an ancestor of origin/master');
  }
  const pinned: Git = async args => JSON.stringify(args) === JSON.stringify(RESOLVE_ARGS) ? `${snapshot}\n` : run(args);
  const { ref: _ref, ...overlap } = await jobOverlap(jobIds, limit, pinned);
  return { ...overlap, requestedSnapshot: snapshot, caveat: CAVEAT };
}
