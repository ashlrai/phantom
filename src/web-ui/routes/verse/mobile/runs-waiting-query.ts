import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { FLEET_RUNS_PATH, readFleetRunsLite, type FleetRunsLite } from './runs-queries.js';
import type { WaitingRuns } from './runs-waiting-model.js';

// The shared lite projection omits drop. Keep both parts from the same response.
export const waitingRunsQuery: QueryDef<FleetRunsLite & WaitingRuns> = {
  key: 'mobile-waiting-runs',
  async fetch(signal) {
    const raw = await apiGet<unknown>(FLEET_RUNS_PATH, signal);
    const lite = readFleetRunsLite(raw);
    if (!lite) throw new ApiError(`GET ${FLEET_RUNS_PATH} answered a shape this build cannot read.`, 502, FLEET_RUNS_PATH, 'Unrecognized response — update Phantom.');
    const drop = (raw as Record<string, unknown>)['drop'];
    if (drop == null) return { ...lite, drop: null };
    if (typeof drop !== 'object' || Array.isArray(drop) || !Array.isArray((drop as Record<string, unknown>)['pending'])
      || !(drop as { pending: unknown[] }).pending.every((item) => item && typeof item === 'object'
        && typeof (item as Record<string, unknown>)['lane'] === 'string' && typeof (item as Record<string, unknown>)['file'] === 'string')) {
      throw new ApiError('Invalid drop folder response.', 502, FLEET_RUNS_PATH, 'Unrecognized response — update Phantom.');
    }
    return { ...lite, drop: drop as WaitingRuns['drop'] };
  },
};
