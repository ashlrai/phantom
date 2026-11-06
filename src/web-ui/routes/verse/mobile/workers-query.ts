import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isFleetWorkers, type FleetWorkers } from './workers-model.js';

export const workersQuery: QueryDef<FleetWorkers | null> = {
  key: 'mobile-fleet-workers',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/runs', signal);
      if (!isFleetWorkers(value)) throw new Error('Invalid fleet workers response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
