import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetMergesQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runs', signal),
};

export const outsidePrsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-outside-prs',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/live/outside-prs', signal),
};
