import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowFleetApps, type FleetAppsResponse } from './apps-card-model.js';

export const appsCardQuery: QueryDef<FleetAppsResponse | null> = {
  key: 'verse-fleet-apps',
  async fetch(signal) {
    try { return narrowFleetApps(await apiGet<unknown>('/api/verse/fleet/apps', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
