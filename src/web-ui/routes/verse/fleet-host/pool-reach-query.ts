import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowPoolReach, type PoolReachView } from './pool-reach-model.js';

/** null means the route has not landed in this build (404). */
export const poolReachQuery: QueryDef<PoolReachView | null> = {
  key: 'verse-fleet-pool-reach',
  async fetch(signal) {
    try { return narrowPoolReach(await apiGet<unknown>('/api/verse/fleet/runtime-identity/pool-reach', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
