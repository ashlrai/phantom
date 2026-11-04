import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBridgeSubject } from './path-job-history.js';

const exec = promisify(execFile);
export const JOB_SCAN_BOUND = 1000;
export const JOB_LIMIT_MAX = 100;

type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

export function validJobId(job: string): boolean {
  return /^RQ-[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/.test(job);
}

export function validJobRef(ref: string): boolean {
  return ref === 'HEAD' || (/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(ref)
    && !ref.includes('..') && !ref.includes('//') && !ref.includes('@{')
    && !ref.endsWith('/') && !ref.endsWith('.')
    && ref.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')));
}

/** Scan at most 1000 commits, newest first; a full scan may have older history. */
export async function jobPathHistory(job: string, ref: string, limit: number, run: Git = git) {
  if (!validJobId(job) || !validJobRef(ref) || !Number.isInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX) {
    throw new Error('invalid job history arguments');
  }
  const output = await run(['log', `-n${JOB_SCAN_BOUND}`, '--format=%H%x00%cI%x00%s%x00', ref, '--']);
  const fields = output.split('\0');
  const commits: Array<{ sha: string; date: string; pr: number | null; paths: string[] }> = [];
  const paths = new Set<string>();
  let scanned = 0, matches = 0;
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const sha = fields[i]!.trim();
    if (!sha) continue;
    scanned++;
    const bridge = parseBridgeSubject(fields[i + 2]!);
    if (bridge?.jobId !== job) continue;
    matches++;
    if (commits.length >= limit) continue;
    const changed = await run(['diff-tree', '--root', '-m', '--first-parent', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha, '--']);
    const commitPaths = [...new Set(changed.split('\0').filter(Boolean))].sort();
    for (const path of commitPaths) paths.add(path);
    commits.push({ sha, date: fields[i + 1]!, pr: bridge.pr, paths: commitPaths });
  }
  return { jobId: job, ref, scanBound: JOB_SCAN_BOUND, scanned, scanMayBeTruncated: scanned === JOB_SCAN_BOUND,
    limit, matchesTruncated: matches > limit, commits, paths: [...paths].sort() };
}
