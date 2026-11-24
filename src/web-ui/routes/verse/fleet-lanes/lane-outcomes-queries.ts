import type { JobOutcomesReport } from '../../../../core/fleet/job-outcomes.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isJobOutcomesReport } from './lane-outcomes-model.js';

/** What every lane's finished jobs produced in the last 24 h; null when the route has not landed in this build. */
export const laneOutcomesQuery: QueryDef<JobOutcomesReport | null> = {
  key: 'fleet-job-outcomes',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/fleet/outcomes?hours=24', signal);
      if (!isJobOutcomesReport(value)) throw new Error('Invalid job outcomes response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
