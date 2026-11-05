import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JOB_LIMIT_MAX, JOB_SCAN_BOUND, validJobId } from './job-path-history.js';
import { parseBridgeSubject } from './path-job-history.js';

const exec = promisify(execFile);
/** At most this many distinct exact job ids share one bounded scan. */
export const JOB_BATCH_MAX = 20;
/** Fixed scan ref: the planner asks about landed work, so only origin/master counts. */
export const JOB_HISTORY_REF = 'origin/master';

type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

export interface JobHistoryBatchJob {
  jobId: string;
  matchesTruncated: boolean;
  commits: Array<{ sha: string; date: string; pr: number | null; paths: string[] }>;
  paths: string[];
}

export interface JobHistoryBatchResult {
  resolvedRef: string;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  limit: number;
  jobs: JobHistoryBatchJob[];
}

/**
 * One bounded git-log scan answers every requested exact job id: the ref is
 * resolved to one immutable commit OID first, so the log scan and every
 * diff-tree path read describe the same tree even if the ref moves mid-read.
 * At most JOB_SCAN_BOUND commits are scanned, newest first; each id keeps at
 * most `limit` matching commits and reports whether more matched. Results are
 * returned in input id order. A missing or truncated result is bounded
 * evidence only — it does not prove the job never landed. Reader failures
 * (missing git, missing ref, unreadable object store) propagate as errors,
 * never as fabricated empty history.
 */
export async function jobHistoryBatch(
  jobIds: string[], limit: number, run: Git = git, options: { at?: string } = {},
): Promise<JobHistoryBatchResult> {
  if (!Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > JOB_BATCH_MAX
    || !Number.isInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX) {
    throw new Error('invalid job history batch arguments');
  }
  const wanted = new Set(jobIds);
  if (wanted.size !== jobIds.length || !jobIds.every(id => typeof id === 'string' && validJobId(id))) {
    throw new Error('invalid job history batch arguments');
  }
  const at = options.at;
  if (at !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(at)) throw new Error('invalid snapshot OID');
  const master = (await run(['rev-parse', '--verify', `${JOB_HISTORY_REF}^{commit}`])).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(master)) throw new Error(`unable to resolve ${JOB_HISTORY_REF}`);
  let resolvedRef = master;
  if (at !== undefined) {
    resolvedRef = (await run(['rev-parse', '--verify', `${at}^{commit}`])).trim();
    if (resolvedRef !== at.toLowerCase()) throw new Error('snapshot must identify a commit');
    await run(['merge-base', '--is-ancestor', resolvedRef, master]);
  }
  const output = await run(['log', `-n${JOB_SCAN_BOUND}`, '--format=%H%x00%cI%x00%s%x00', resolvedRef, '--']);
  const fields = output.split('\0');
  const matches = new Map<string, number>(jobIds.map(id => [id, 0]));
  const commits = new Map<string, JobHistoryBatchJob['commits']>(jobIds.map(id => [id, []]));
  const paths = new Map<string, Set<string>>(jobIds.map(id => [id, new Set()]));
  let scanned = 0;
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const sha = fields[i]!.trim();
    if (!sha) continue;
    scanned++;
    const bridge = parseBridgeSubject(fields[i + 2]!);
    if (!bridge || !wanted.has(bridge.jobId)) continue;
    const jobId = bridge.jobId;
    matches.set(jobId, matches.get(jobId)! + 1);
    const kept = commits.get(jobId)!;
    if (kept.length >= limit) continue;
    const changed = await run(['diff-tree', '--root', '-m', '--first-parent', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha, '--']);
    const commitPaths = [...new Set(changed.split('\0').filter(Boolean))].sort();
    for (const path of commitPaths) paths.get(jobId)!.add(path);
    kept.push({ sha, date: fields[i + 1]!, pr: bridge.pr, paths: commitPaths });
  }
  return {
    resolvedRef, scanBound: JOB_SCAN_BOUND, scanned,
    scanMayBeTruncated: scanned === JOB_SCAN_BOUND, limit,
    jobs: jobIds.map(jobId => ({
      jobId,
      matchesTruncated: matches.get(jobId)! > limit,
      commits: commits.get(jobId)!,
      paths: [...paths.get(jobId)!].sort(),
    })),
  };
}
