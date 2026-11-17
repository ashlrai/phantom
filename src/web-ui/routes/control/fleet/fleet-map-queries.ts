import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { FleetCompute } from '../../../../core/fleet/compute-view.js';
import type { FleetSessionMap } from '../../../../core/fleet/sessions-view.js';
import { isFleetCompute, isFleetSessionMap } from '../../verse/company/compute-model.js';

export const fleetComputeQuery: QueryDef<FleetCompute> = {
  key: 'fleet-map-compute',
  fetch: async signal => {
    const value = await apiGet<unknown>('/api/verse/fleet/control/compute', signal);
    if (!isFleetCompute(value)) throw new Error('Unsupported compute observation');
    return value;
  },
};
export const fleetSessionMapQuery: QueryDef<FleetSessionMap> = {
  key: 'fleet-map-sessions',
  fetch: async signal => {
    const value = await apiGet<unknown>('/api/verse/fleet/control/sessions', signal);
    if (!isFleetSessionMap(value)) throw new Error('Unsupported session observation');
    return value;
  },
};
