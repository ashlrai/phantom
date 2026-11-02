import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetEventsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runs', signal),
};
