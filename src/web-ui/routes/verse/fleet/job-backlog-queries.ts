import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export function jobBacklogQuery(repo: string): QueryDef<unknown> {
  return {
    key: `verse-github-fleet-backlog:${repo.toLowerCase()}`,
    async fetch(signal) {
      try {
        return await apiGet<unknown>(`/api/verse/github/fleet-backlog?repo=${encodeURIComponent(repo)}`, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}

/** Worker rows can carry a short repo name; the PR URL supplies its owner. */
export function jobBacklogRepo(repo: string | null | undefined, prUrl: string | null | undefined): string | null {
  const valid = (value: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
  if (repo && valid(repo)) return repo;
  if (!repo || !prUrl) return null;
  try {
    const url = new URL(prUrl);
    const match = /^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match || match[2]?.toLowerCase() !== repo.toLowerCase()) return null;
    const full = `${match[1]}/${match[2]}`;
    return valid(full) ? full : null;
  } catch { return null; }
}
