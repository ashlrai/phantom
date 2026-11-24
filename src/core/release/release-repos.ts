/** Shared commit-based cadence for the CLI, desktop and phone. Reads never mutate clones. */
import { CADENCE_REPOS } from './cadence.js';
import { readGitRelease, releaseClonePaths, type GitReleaseRow } from './git-backlog.js';
import { readRemoteGitRelease } from './remote-git-backlog.js';

export interface ReleaseRepoStatus extends Omit<GitReleaseRow, 'state' | 'reason'> {
  state: 'ok' | 'due' | 'stale' | 'unknown'; reason: string;
}
export interface ReleaseReposOptions {
  now?: number; repos?: readonly string[]; paths?: (repo: string) => readonly string[];
  remote?: typeof readRemoteGitRelease;
}
export async function readReleaseRepos(opts: ReleaseReposOptions = {}): Promise<ReleaseRepoStatus[]> {
  const now = opts.now ?? Date.now();
  return Promise.all((opts.repos ?? CADENCE_REPOS).map(async repo => {
    let local = await readGitRelease(repo, undefined, now);
    for (const path of (opts.paths ?? releaseClonePaths)(repo)) {
      const row = await readGitRelease(repo, path, now);
      if (row.reason !== 'no local clone') local = row;
      if (row.state !== 'unknown') break;
    }
    const row = local.state === 'unknown' ? await (opts.remote ?? readRemoteGitRelease)(local, now) : local;
    if (row.reason === 'remote has no release tags') return { ...row, state: 'due', reason: 'No release yet.' };
    if (row.state === 'unknown') return { ...row, reason: `Local: ${local.reason}; remote: ${row.reason}.` };
    const age = (now - Date.parse(row.tagDate!)) / 86_400_000;
    const state = row.commitsSinceTag === 0 ? 'ok' : age > 14 ? 'stale' : row.commitsSinceTag! > 20 || age > 7 ? 'due' : 'ok';
    const reason = row.commitsSinceTag === 0 ? 'Nothing waiting to release.' : state === 'stale' ? 'Changes waiting; last release over 14 days ago.'
      : state === 'due' ? 'Changes waiting; over 20 commits or 7 days since release.' : 'Release cadence is current.';
    return { ...row, state, reason };
  }));
}

export function releaseRepoLine(row: ReleaseRepoStatus, now = Date.now()): string {
  const name = row.repo.replace(/^ashlrai\//, '');
  if (!row.latestTag) return `${name}: ${row.state === 'due' ? 'no release yet' : 'unknown'}`;
  const minutes = row.tagDate === null ? null : Math.max(0, Math.floor((now - Date.parse(row.tagDate)) / 60_000));
  const value = minutes === null ? null : minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1440);
  const unit = minutes === null ? '' : minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  const age = value === null ? 'unknown age' : `${value} ${unit}${value === 1 ? '' : 's'} ago`;
  return `${name}: ${row.latestTag}, ${age}, ${row.commitsSinceTag === null ? 'unknown commits waiting' : `${row.commitsSinceTag} commit${row.commitsSinceTag === 1 ? '' : 's'} waiting`}`;
}
