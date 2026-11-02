import { VERSE_FLEET_RUNS_PATH } from '../../../../core/verse/fleet-runs-types.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** GET /api/verse/fleet/runs — shared key with the other fleet panes so this rides the same cache and SSE invalidation. */
export const fleetUsageRunsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>(VERSE_FLEET_RUNS_PATH, signal),
};
