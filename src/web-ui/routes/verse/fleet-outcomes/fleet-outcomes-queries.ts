import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const outcomesQuery: QueryDef<unknown> = {
  key: 'verse-fleet-outcomes',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/live/feedback', signal),
};

// One def per case id: useRefetch/useQuery memo on the def object, so a fresh
// object per render would retrigger them even though the cache key matches.
const caseQueries = new Map<string, QueryDef<unknown>>();

export function outcomeCaseQuery(caseId: string): QueryDef<unknown> {
  let def = caseQueries.get(caseId);
  if (!def) {
    def = {
      key: `verse-fleet-outcome-case:${caseId}`,
      fetch: signal => apiGet<unknown>(`/api/verse/fleet/live/feedback/cases/${encodeURIComponent(caseId)}`, signal),
    };
    caseQueries.set(caseId, def);
  }
  return def;
}
