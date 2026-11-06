import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** The drawer's poll cadence while it is open. */
export const FLEET_NEEDS_YOU_POLL_MS = 15_000;

/**
 * The drawer's read of the fleet running on this Mac — the same cache key
 * the Ops merge pulse and Settings' source rows already share
 * (merge-pulse-queries.ts, fleet-sources-query.ts), so one request serves
 * every surface watching it and one SSE invalidation refreshes them all.
 */
export const fleetRunsNeedsYouQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runs', signal),
};
