import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isFleetRuns, type FleetRuns } from './ops-runs-model.js';

export const opsRunsQuery: QueryDef<FleetRuns | null> = {
  key: 'verse-fleet-runs',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/runs', signal);
      if (!isFleetRuns(value)) throw new Error('Invalid live runs response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
