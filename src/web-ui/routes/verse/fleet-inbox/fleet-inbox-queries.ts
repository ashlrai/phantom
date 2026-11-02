import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetRunsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs', fetch: s => apiGet('/api/verse/fleet/runs', s),
};
export const fleetInboxQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs-inbox-100', fetch: s => apiGet('/api/verse/fleet/runs/inbox?limit=100', s),
};
export const ordersTraceQuery: QueryDef<unknown> = {
  key: 'verse-leader-orders', fetch: s => apiGet('/api/verse/leader/orders', s),
};
