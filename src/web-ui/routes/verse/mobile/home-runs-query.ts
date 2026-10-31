import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isHomeFleetRuns, type FleetRuns } from './home-runs-model.js';

export const homeRunsQuery: QueryDef<FleetRuns | null> = {
  key: 'mobile-fleet-runs',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/runs', signal);
      if (!isHomeFleetRuns(value)) throw new Error('Invalid live runs response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
