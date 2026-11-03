import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowForum, type ForumView } from './forum-view.js';

export function forumQuery(channel: string | null): QueryDef<ForumView | null> {
  const params = channel ? `?channel=${encodeURIComponent(channel)}` : '';
  return {
    key: `verse-forum:${channel ?? 'all'}`,
    fetch: async (signal) => {
      try {
        return narrowForum(await apiGet<unknown>(`/api/verse/forum${params}`, signal));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
