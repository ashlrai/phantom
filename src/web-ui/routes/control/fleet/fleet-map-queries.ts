import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { FleetCompute } from '../../../../core/fleet/compute-view.js';
import type { FleetSessionMap } from '../../../../core/fleet/sessions-view.js';

export const fleetComputeQuery: QueryDef<FleetCompute> = {
  key: 'fleet-map-compute',
  fetch: signal => apiGet<FleetCompute>('/api/verse/fleet/control/compute', signal),
};
export const fleetSessionMapQuery: QueryDef<FleetSessionMap> = {
  key: 'fleet-map-sessions',
  fetch: signal => apiGet<FleetSessionMap>('/api/verse/fleet/control/sessions', signal),
};
