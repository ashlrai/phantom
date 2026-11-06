import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const leaderPassesQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet('/api/verse/fleet/runs', signal),
};
