/** Public, read-only tag evidence; no clone mutation or credential-bearing URLs. */
import { execFile } from 'node:child_process';
import { CADENCE_REPOS } from './cadence.js';
import type { GitReleaseRow } from './git-backlog.js';

export type ReleaseGet = (path: string, signal: AbortSignal) => Promise<unknown>;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
const publicGet: ReleaseGet = async (path, signal) => {
  const response = await fetch(`https://api.github.com/${path}`, { signal, headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error('GitHub unavailable');
  return response.json();
};
const remoteRefs = (repo: string, signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['ls-remote', '--sort=-version:refname', `https://github.com/ashlrai/${repo}.git`, 'HEAD', 'refs/tags/*'],
    { signal, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (error, stdout) => error ? reject(new Error('Remote tags unavailable')) : resolve(stdout));
});

export async function readRemoteGitRelease(local: GitReleaseRow, now: number, get: ReleaseGet = publicGet, listRefs = remoteRefs): Promise<GitReleaseRow> {
  const row: GitReleaseRow = { ...local, latestTag: null, tagDate: null, commitsSinceTag: null, state: 'unknown', source: 'remote git', reason: 'remote tags unavailable' };
  if (!CADENCE_REPOS.some(repo => repo === local.repo)) return row;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Remote read timed out')); }, 5000); });
  try {
    return await Promise.race([timeout, (async (): Promise<GitReleaseRow> => {
      const refs = await listRefs(local.repo, controller.signal);
      const entries = refs.trim().split('\n').map(line => line.split('\t'));
      // Version order, stable release tags only; peeled refs describe annotated tags.
      const tag = entries.find(([, ref]) => /^refs\/tags\/v?\d+(?:\.\d+)*$/.test(ref ?? ''));
      row.reason = 'remote has no release tags';
      if (!tag) return row;
      row.latestTag = tag[1]!.slice('refs/tags/'.length);
      const head = entries.find(([, ref]) => ref === 'HEAD')?.[0];
      const annotated = entries.some(([, ref]) => ref === `${tag[1]}^{}`);
      const read = async (path: string) => record(await get(`repos/ashlrai/${local.repo}/${path}`, controller.signal));
      row.reason = 'remote tag date unavailable';
      const detail = await read(`${annotated ? 'git/tags' : 'commits'}/${encodeURIComponent(tag[0]!)}`);
      const date = annotated ? record(detail.tagger).date : record(record(detail.commit).committer).date;
      if (typeof date !== 'string' || !Number.isFinite(Date.parse(date))) return row;
      row.tagDate = new Date(date).toISOString();
      row.reason = 'commit count since remote tag unavailable';
      if (!head) return row;
      const compare = await read(`compare/${encodeURIComponent(row.latestTag)}...${encodeURIComponent(head)}?per_page=1`);
      if (!['ahead', 'identical'].includes(String(compare.status)) || !Number.isSafeInteger(compare.total_commits) || Number(compare.total_commits) < 0) return row;
      row.commitsSinceTag = Number(compare.total_commits);
      return { ...row, state: row.commitsSinceTag > 20 || now - Date.parse(row.tagDate) > 7 * 86_400_000 ? 'due' : 'ok', reason: null };
    })()]);
  } catch { return row; } finally { clearTimeout(timer); controller.abort(); }
}
