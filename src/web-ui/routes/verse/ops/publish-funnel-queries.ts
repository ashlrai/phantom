import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const publishFunnelQuery: QueryDef<unknown> = {
  key: 'verse-ops-publish-funnel',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runs', signal),
};
