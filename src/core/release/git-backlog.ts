/** Local tag evidence only: never fetches, publishes, or invokes gh. */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asReleaseRecord, gitReleaseState, parseReleaseIso, parseWholeNumber } from './cadence.js';

export interface GitReleaseRow {
  repo: string; latestTag: string | null; tagDate: string | null; commitsSinceTag: number | null;
  state: 'ok' | 'due' | 'unknown'; reason: string | null;
  source?: 'remote git';
}

/** PHANTOM_RELEASE_CLONES replaces defaults with a JSON object of repo names to clone paths. */
export function releaseClonePaths(repo: string): string[] {
  if (process.env.PHANTOM_RELEASE_CLONES !== undefined) {
    try {
      const config = asReleaseRecord(JSON.parse(process.env.PHANTOM_RELEASE_CLONES));
      if (!config) return [];
      const path: unknown = config[repo];
      return typeof path === 'string' && path ? [path] : [];
    } catch { return []; }
  }
  const root = join(homedir(), 'Projects', 'ashlrai');
  return [join(root, 'wt', `guardian-${repo}`), ...(repo === 'phantom' ? [join(homedir(), '.ashlr-runs', 'phm-live')] : []), join(root, repo)];
}

export async function readGitRelease(repo: string, path: string | undefined, now = Date.now()): Promise<GitReleaseRow> {
  const row: GitReleaseRow = { repo, latestTag: null, tagDate: null, commitsSinceTag: null, state: 'unknown', reason: 'no local clone' };
  if (!path || !await access(join(path, '.git')).then(() => true, () => false)) return row;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  const git = (...args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile('git', ['-C', path, ...args], { encoding: 'utf8', signal: controller.signal, timeout: 1500, maxBuffer: 64 * 1024 },
      (error, stdout) => error ? reject(new Error('local git unavailable')) : resolve(stdout.trim()));
  });
  try {
    row.reason = 'no default-branch ref';
    const symbolic = await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').catch(() => '');
    let head = '';
    for (const ref of symbolic ? [symbolic] : ['refs/remotes/origin/master', 'refs/remotes/origin/main']) {
      head = await git('rev-parse', '--verify', `${ref}^{commit}`).catch(() => '');
      if (head) break;
    }
    if (!head) return row;
    row.reason = 'no reachable tags';
    row.latestTag = await git('describe', '--tags', '--abbrev=0', head);
    row.reason = 'tag date or commit count unavailable';
    const tag = `refs/tags/${row.latestTag}`;
    const tagDate = parseReleaseIso(await git('for-each-ref', '--format=%(creatordate:iso-strict)', tag));
    if (!tagDate) return row;
    row.tagDate = tagDate;
    // Shallow history can silently undercount: leave it unknown rather than claim a fresh release.
    if (await git('rev-parse', '--is-shallow-repository') !== 'false') return { ...row, reason: 'shallow local clone' };
    const commits = parseWholeNumber(await git('rev-list', '--count', `${tag}..${head}`));
    if (commits === null) return row;
    row.commitsSinceTag = commits;
    return { ...row, state: gitReleaseState(row.commitsSinceTag, row.tagDate, now), reason: null };
  } catch { return row; } finally { clearTimeout(timer); }
}

export async function readLocalGitRelease(repo: string, now: number): Promise<GitReleaseRow> {
  for (const path of releaseClonePaths(repo)) {
    const row = await readGitRelease(repo, path, now);
    if (row.reason !== 'no local clone') return row;
  }
  return readGitRelease(repo, undefined, now);
}
