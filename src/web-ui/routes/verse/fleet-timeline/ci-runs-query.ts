import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export function ciRunsQuery(from: number, to: number): QueryDef<unknown> {
  const hours = Math.max(1, Math.min(168, Math.ceil((to - from) / 3_600_000) || 1));
  return {
    key: `verse-fleet-ci-runs:${hours}`,
    async fetch(signal) {
      try { return await apiGet<unknown>(`/api/verse/fleet/ci-runs?hours=${hours}`, signal); }
      catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
