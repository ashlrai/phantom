/** Read-only release backlog: bounded GitHub reads/cache, then local git for missing evidence. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CADENCE_REPOS } from './cadence.js';
import { readLocalGitRelease, type GitReleaseRow } from './git-backlog.js';

export const BACKLOG_TTL = 600_000;
export interface BacklogRow {
  repo: string; latestTag: string | null; releasedAt: string | null;
  mergedCommits: number | null; oldestUnreleasedAt: string | null;
  oldestUnreleasedAgeDays: number | null; verdict: 'ok' | 'due' | 'stale' | 'unknown';
  git?: GitReleaseRow;
}
type Facts = Pick<BacklogRow, 'latestTag' | 'releasedAt' | 'mergedCommits' | 'oldestUnreleasedAt'>;
export interface BacklogOptions {
  now?: number; stateDir?: string; cacheOnly?: boolean;
  get?: (path: string, signal: AbortSignal) => Promise<unknown>;
}
const validDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
const gh = (path: string, signal: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
  execFile('gh', ['api', '--method', 'GET', path, '--jq', path.includes('/compare/') ? '{status,total_commits,commits:[.commits[]|{sha,parents,commit:{committer:{date:.commit.committer.date}}}]}' : '{tag_name,published_at,default_branch,sha}'], { signal, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(new Error('GitHub unavailable'));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid GitHub response')); }
  });
});
function facts(v: unknown): Facts {
  const r = record(v);
  if (typeof r.latestTag !== 'string' || !r.latestTag || !validDate(r.releasedAt) ||
    !Number.isSafeInteger(r.mergedCommits) || Number(r.mergedCommits) < 0 ||
    (r.mergedCommits !== 0 && !validDate(r.oldestUnreleasedAt))) throw new Error('Unknown release');
  return { latestTag: r.latestTag, releasedAt: r.releasedAt, mergedCommits: Number(r.mergedCommits), oldestUnreleasedAt: r.mergedCommits === 0 ? null : r.oldestUnreleasedAt as string };
}
async function readRepo(repo: string, opts: BacklogOptions, now: number): Promise<BacklogRow> {
  const file = join(opts.stateDir ?? join(homedir(), '.ashlr', 'state'), 'release-backlog', `${repo}.json`);
  const unknown: BacklogRow = { repo, latestTag: null, releasedAt: null, mergedCommits: null, oldestUnreleasedAt: null, oldestUnreleasedAgeDays: null, verdict: 'unknown' };
  let data: Facts;
  try {
    try {
      const cached = record(JSON.parse(await readFile(file, 'utf8')));
      if (cached.schema !== 1 || cached.repo !== repo || typeof cached.at !== 'number' || now < cached.at || now - cached.at >= BACKLOG_TTL) throw new Error('Expired');
      data = facts(cached.data);
    } catch {
      if (opts.cacheOnly) return unknown;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Timed out')); }, 5000); });
      try {
        data = await Promise.race([timeout, (async () => {
          const get = (path: string) => (opts.get ?? gh)(`repos/ashlrai/${repo}${path ? `/${path}` : ''}`, controller.signal);
          const [release, meta] = (await Promise.all([get('releases/latest'), get('')])).map(record);
          if (typeof release!.tag_name !== 'string' || typeof meta!.default_branch !== 'string') throw new Error('Unknown release');
          const head = record(await get(`commits/${encodeURIComponent(meta!.default_branch)}`)).sha;
          if (typeof head !== 'string' || !head) throw new Error('Unknown head');
          const path = `compare/${encodeURIComponent(release!.tag_name)}...${encodeURIComponent(head)}?per_page=100`;
          const compare = record(await get(`${path}&page=1`));
          if (!['ahead', 'identical'].includes(String(compare.status))) throw new Error('Release is not an ancestor');
          const commits = Array.isArray(compare.commits) ? compare.commits.map(record) : [];
          const total = compare.total_commits;
          if (!Number.isSafeInteger(total) || Number(total) < 0) throw new Error('Unknown count');
          for (let page = 2; commits.length < Number(total); page++) {
            const next = record(await get(`${path}&page=${page}`));
            if (!Array.isArray(next.commits) || !next.commits.length) throw new Error('Incomplete comparison');
            commits.push(...next.commits.map(record));
          }
          const bySha = new Map(commits.map(c => [c.sha, c]));
          let cursor = commits.at(-1), date: string | null = null;
          const seen = new Set<unknown>();
          // Mainline dates measure merge age; old branch commits may only have merged today.
          while (cursor) {
            const at = record(record(cursor.commit).committer).date;
            if (typeof cursor.sha !== 'string' || seen.has(cursor.sha) || !validDate(at) || !Array.isArray(cursor.parents)) throw new Error('Incomplete mainline');
            seen.add(cursor.sha);
            if (date === null || Date.parse(at) < Date.parse(date)) date = at;
            cursor = bySha.get(record(cursor.parents[0]).sha);
          }
          return facts({ latestTag: release!.tag_name, releasedAt: release!.published_at, mergedCommits: compare.total_commits, oldestUnreleasedAt: date });
        })()]);
      } finally { clearTimeout(timer); controller.abort(); }
      try {
        await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
        await writeFile(file, JSON.stringify({ schema: 1, repo, at: now, data }), { mode: 0o600 });
      } catch { /* Cache availability never changes the reading. */ }
    }
    const age = data.oldestUnreleasedAt === null ? null : Math.max(0, (now - Date.parse(data.oldestUnreleasedAt)) / 86_400_000);
    const verdict = data.mergedCommits === 0 ? 'ok' : age !== null && age >= 7 ? 'stale' : data.mergedCommits! >= 20 || (age !== null && age >= 3) ? 'due' : 'ok';
    return { repo, ...data, oldestUnreleasedAgeDays: age, verdict };
  } catch { return unknown; }
}
export async function readReleaseBacklog(opts: BacklogOptions = {}) {
  const now = opts.now ?? Date.now();
  const repos = await Promise.all(CADENCE_REPOS.map(async repo => {
    const row = await readRepo(repo, opts, now);
    if (row.verdict !== 'unknown') return row;
    const git = await readLocalGitRelease(repo, now);
    return { ...row, git, latestTag: git.latestTag, releasedAt: git.tagDate, mergedCommits: git.commitsSinceTag, verdict: git.state };
  }));
  const counts = { ok: 0, due: 0, stale: 0, unknown: 0 };
  for (const row of repos) counts[row.verdict]++;
  return { schema: 'phantom.release-backlog.v1' as const, checkedAt: new Date(now).toISOString(), counts, repos };
}
export function backlogLines(report: Awaited<ReturnType<typeof readReleaseBacklog>>): string[] {
  return report.repos.map(r => `${r.repo}: ${r.verdict}; ${r.latestTag ?? 'unknown'} (${r.releasedAt ?? 'unknown'}); ${r.mergedCommits ?? 'unknown'} commits; oldest ${r.oldestUnreleasedAgeDays === null ? r.mergedCommits === 0 ? 'none' : 'unknown' : `${r.oldestUnreleasedAgeDays.toFixed(1)} days`}${r.git ? `; local git${r.git.reason ? `: ${r.git.reason}` : ''}` : ''}`);
}
