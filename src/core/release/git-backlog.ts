/** Local tag evidence only: never fetches, publishes, or invokes gh. */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GitReleaseRow {
  repo: string; latestTag: string | null; tagDate: string | null; commitsSinceTag: number | null;
  state: 'ok' | 'due' | 'unknown'; reason: string | null;
}

/** PHANTOM_RELEASE_CLONES replaces defaults with a JSON object of repo names to clone paths. */
export function releaseClonePaths(repo: string): string[] {
  if (process.env.PHANTOM_RELEASE_CLONES !== undefined) {
    try {
      const config: unknown = JSON.parse(process.env.PHANTOM_RELEASE_CLONES);
      if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
      const path: unknown = (config as Record<string, unknown>)[repo];
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
    const date = await git('for-each-ref', '--format=%(creatordate:iso-strict)', tag);
    if (!Number.isFinite(Date.parse(date))) return row;
    row.tagDate = new Date(date).toISOString();
    // Shallow history can silently undercount: leave it unknown rather than claim a fresh release.
    if (await git('rev-parse', '--is-shallow-repository') !== 'false') return { ...row, reason: 'shallow local clone' };
    const count = await git('rev-list', '--count', `${tag}..${head}`);
    if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) return row;
    row.commitsSinceTag = Number(count);
    return { ...row, state: row.commitsSinceTag > 20 || now - Date.parse(row.tagDate) > 7 * 86_400_000 ? 'due' : 'ok', reason: null };
  } catch { return row; } finally { clearTimeout(timer); }
}

export async function readLocalGitRelease(repo: string, now: number): Promise<GitReleaseRow> {
  for (const path of releaseClonePaths(repo)) {
    const row = await readGitRelease(repo, path, now);
    if (row.reason !== 'no local clone') return row;
  }
  return readGitRelease(repo, undefined, now);
}
