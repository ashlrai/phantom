import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowRunsLanes, type RunsLanes } from './runs-lanes-model.js';

let missing: ApiError | undefined;
export const runsLanesQuery: QueryDef<RunsLanes> = {
  key: 'verse-fleet-runs-lanes',
  async fetch(signal) {
    if (missing) throw missing;
    try {
      const data = narrowRunsLanes(await apiGet<unknown>('/api/verse/fleet/runs', signal));
      if (!data) throw new Error('Invalid runs lanes response');
      return data;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};
