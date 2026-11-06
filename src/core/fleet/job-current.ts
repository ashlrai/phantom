import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JOB_HISTORY_REF } from './job-history-batch.js';
import { jobPathHistory, validJobId } from './job-path-history.js';

const exec = promisify(execFile);
/** At most this many paths touched by the newest bridge commit are compared. */
export const JOB_CURRENT_PATH_BOUND = 200;

type Git = (args: string[]) => Promise<string>;
const git: Git = async args => (await exec('git', args, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
})).stdout;

/** One ls-tree record: mode, object type (blob/tree/commit) and object id. */
export interface JobTreeEntry { mode: string; type: string; oid: string }
/**
 * unchanged: identical mode/type/oid at the commit and current master.
 * changed: current entry differs — a later edit, or a file re-created after a
 * landed deletion (atCommit null, atCurrent set). Never a behavior verdict.
 * absent-now: the commit left an object here; current master has none.
 * absent-at-both: the commit left none (e.g. a landed deletion) and current
 * master still has none — this is consistency evidence, never missing work.
 */
export type JobCurrentStatus = 'unchanged' | 'changed' | 'absent-now' | 'absent-at-both';
export interface JobCurrentEntry {
  path: string;
  status: JobCurrentStatus;
  atCommit: JobTreeEntry | null;
  atCurrent: JobTreeEntry | null;
}
export interface JobCurrentReport {
  jobId: string;
  ref: string;
  resolvedRef: string;
  scanBound: number;
  scanned: number;
  scanMayBeTruncated: boolean;
  matchesTruncated: boolean;
  commit: { sha: string; date: string; pr: number | null } | null;
  pathBound: number;
  omittedPaths: number;
  summary: { unchanged: number; changed: number; absentNow: number; absentAtBoth: number };
  entries: JobCurrentEntry[];
}

function parseTreeEntries(output: string, tree: string): Map<string, JobTreeEntry> {
  const entries = new Map<string, JobTreeEntry>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const head = tab < 0 ? [] : record.slice(0, tab).split(' ');
    if (head.length !== 3 || !/^[0-7]{6}$/.test(head[0]!) || !/^[0-9a-f]{40,64}$/.test(head[2]!)) {
      throw new Error(`malformed git ls-tree output for ${tree}`);
    }
    entries.set(record.slice(tab + 1), { mode: head[0]!, type: head[1]!, oid: head[2]! });
  }
  return entries;
}

/**
 * Read the exact entry at each literal path in one tree. `:(literal)` kills
 * glob magic (paths with spaces, `[` or `*` are literal), `-z` kills quoting
 * and `--full-tree` makes paths root-relative from any cwd. One caveat: a
 * pathspec naming a directory is a prefix match, so when another requested
 * path descends into it ls-tree expands it to children and drops its own
 * record — those ancestor paths are re-read alone so evidence stays exact.
 */
async function readTree(run: Git, tree: string, paths: string[]): Promise<Map<string, JobTreeEntry>> {
  if (!paths.length) return new Map();
  const ls = (specs: string[]) => run(['ls-tree', '-z', '--full-tree', tree, '--', ...specs]);
  const entries = parseTreeEntries(await ls(paths.map(path => `:(literal)${path}`)), tree);
  for (const path of paths) {
    if (entries.has(path) || !paths.some(other => other.startsWith(`${path}/`))) continue;
    for (const [key, entry] of parseTreeEntries(await ls([`:(literal)${path}`]), tree)) {
      if (key === path) entries.set(key, entry);
    }
  }
  return entries;
}

/**
 * For one exact job id, compare what the newest matching bridge commit left
 * at each touched path with what origin/master holds now — object evidence a
 * recut decision can use instead of treating a historical merge as proof the
 * code is still present. The history reader resolves origin/master to one
 * immutable OID first; every tree read below runs on that OID or the commit's
 * own SHA, so a moving ref cannot skew the comparison. History truncation
 * caveats pass through; empty evidence does not prove a job never landed.
 * Git failures propagate — evidence is never fabricated. Read-only.
 */
export async function jobCurrent(job: string, run: Git = git): Promise<JobCurrentReport> {
  if (!validJobId(job)) throw new Error('invalid job id');
  const history = await jobPathHistory(job, JOB_HISTORY_REF, 1, run);
  const commit = history.commits[0];
  const report: JobCurrentReport = {
    jobId: job, ref: JOB_HISTORY_REF, resolvedRef: history.resolvedRef,
    scanBound: history.scanBound, scanned: history.scanned,
    scanMayBeTruncated: history.scanMayBeTruncated, matchesTruncated: history.matchesTruncated,
    commit: commit ? { sha: commit.sha, date: commit.date, pr: commit.pr } : null,
    pathBound: JOB_CURRENT_PATH_BOUND, omittedPaths: 0,
    summary: { unchanged: 0, changed: 0, absentNow: 0, absentAtBoth: 0 }, entries: [],
  };
  if (!commit) return report;
  const paths = commit.paths.slice(0, JOB_CURRENT_PATH_BOUND);
  report.omittedPaths = commit.paths.length - paths.length;
  const [atCommit, atCurrent] = await Promise.all([
    readTree(run, commit.sha, paths), readTree(run, history.resolvedRef, paths)]);
  const keys = { unchanged: 'unchanged', changed: 'changed', 'absent-now': 'absentNow', 'absent-at-both': 'absentAtBoth' } as const;
  for (const path of paths) {
    const before = atCommit.get(path) ?? null, now = atCurrent.get(path) ?? null;
    const status: JobCurrentStatus = !before
      ? (now ? 'changed' : 'absent-at-both')
      : !now ? 'absent-now'
        : (before.mode === now.mode && before.type === now.type && before.oid === now.oid ? 'unchanged' : 'changed');
    report.summary[keys[status]]++;
    report.entries.push({ path, status, atCommit: before, atCurrent: now });
  }
  return report;
}
