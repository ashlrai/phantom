import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const phonePendingQuery: QueryDef<unknown> = {
  key: 'verse-remote-pending-needs-you',
  async fetch(signal) {
    try {
      return await apiGet<unknown>('/api/verse/fleet/control/remote-pending', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: 'notInBuild' };
      throw error;
    }
  },
};
