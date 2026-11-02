import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const dropQueueQuery: QueryDef<unknown> = {
  key: 'verse-fleet-drop-jobs',
  async fetch(signal) {
    try {
      return await apiGet<unknown>('/api/verse/fleet/live/drop-jobs', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
