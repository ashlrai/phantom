import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';
import type { VerseGithubSnapshot } from '../../../../core/verse/github-types.js';
import type { RepoBacklog } from './repo-backlog-model.js';

export const MAX_BACKLOG_REPOS = 12;
export const MAX_BACKLOG_IN_FLIGHT = 3;
const OWNER_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

/** Distinct owner/name strings of the enrolled GitHub roots, in index order. */
export function enrolledRepos(index: VerseGithubSnapshot | null | undefined): string[] {
  const seen = new Set<string>();
  for (const root of Array.isArray(index?.repos) ? index.repos : []) {
    const name = root?.remote?.state === 'github' ? root.remote.nameWithOwner : null;
    if (typeof name === 'string' && OWNER_NAME_RE.test(name)) seen.add(name.toLowerCase());
  }
  return [...seen].slice(0, MAX_BACKLOG_REPOS);
}

const unread = (repo: string, state: 'not-enrolled' | 'unavailable'): RepoBacklog =>
  ({ repo, state, open: 0, dirty: 0, behind: 0, clean: 0, oldestDirtyAt: null });

async function readRepo(repo: string, signal?: AbortSignal): Promise<RepoBacklog> {
  try {
    const read = await apiGet<MergeBacklogReadV1>(`/api/verse/github/fleet-backlog?repo=${encodeURIComponent(repo)}`, signal);
    if (read?.source !== 'ok' || !Array.isArray(read.items) || !read.counts?.mergeState) return unread(repo, 'unavailable');
    const oldest = read.items.filter(item => item.mergeStateStatus === 'DIRTY')
      .map(item => item.updatedAt).filter((at): at is string => at !== null && Number.isFinite(Date.parse(at)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    const { mergeState } = read.counts;
    return { repo, state: 'ok', open: read.items.length, dirty: mergeState.DIRTY ?? 0, behind: mergeState.BEHIND ?? 0, clean: mergeState.CLEAN ?? 0, oldestDirtyAt: oldest };
  } catch (error) {
    if (signal?.aborted) throw error;
    return unread(repo, error instanceof ApiError && error.status === 404 ? 'not-enrolled' : 'unavailable');
  }
}

export async function readRepoBacklogs(signal?: AbortSignal): Promise<RepoBacklog[]> {
  const repos = enrolledRepos(await apiGet<VerseGithubSnapshot>('/api/verse/github', signal));
  const results: RepoBacklog[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const at = next++;
      results[at] = await readRepo(repos[at]!, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_BACKLOG_IN_FLIGHT, repos.length) }, worker));
  return results;
}

export const repoBacklogQuery: QueryDef<RepoBacklog[]> = {
  key: 'verse-merges-repo-backlog',
  fetch: signal => readRepoBacklogs(signal),
};
