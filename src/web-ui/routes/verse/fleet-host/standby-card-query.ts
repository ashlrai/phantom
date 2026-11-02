import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowFleetStandby, type FleetStandbyView } from './standby-card-model.js';

export const standbyCardQuery: QueryDef<FleetStandbyView | null> = {
  key: 'verse-fleet-standby',
  async fetch(signal) {
    try { return narrowFleetStandby(await apiGet<unknown>('/api/verse/fleet/standby', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
