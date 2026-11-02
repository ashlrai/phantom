import { apiGet, ApiError } from '../../data/client.js';
import type { QueryDef } from '../../data/queries.js';

/** Older servers need not mount this optional fleet projection. */
export const fleetRunsNotifyQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  async fetch(signal) {
    try {
      return await apiGet<unknown>('/api/verse/fleet/runs', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
