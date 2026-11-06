import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetChannelsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runs', signal),
};
