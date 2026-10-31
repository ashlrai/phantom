import { useEffect, useSyncExternalStore } from 'react';
import { getQuerySnapshot } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';

interface FleetRunsResponse {
  v: 1;
  workers: Array<{ job: string }>;
  leaders: unknown[];
  mergesLastHour: { count: number | null };
  switches: string[];
  sources?: Record<string, string>;
}

export interface FleetRunsBadge {
  workers: number;
  merges: number | null;
  switchesOn: string[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reject incomplete responses instead of reporting an invented zero. */
export function fleetRunsBadge(data: unknown): FleetRunsBadge | null {
  if (!record(data) || data.v !== 1 || !Array.isArray(data.workers)
    || !data.workers.every(worker => record(worker) && typeof worker.job === 'string')
    || !Array.isArray(data.leaders) || !record(data.mergesLastHour)
    || !(data.mergesLastHour.count === null || (Number.isSafeInteger(data.mergesLastHour.count) && (data.mergesLastHour.count as number) >= 0))
    || !Array.isArray(data.switches) || !data.switches.every(item => typeof item === 'string')
    || (data.sources !== undefined && (!record(data.sources) || !Object.values(data.sources).every(value => typeof value === 'string')))) return null;
  return { workers: data.workers.length, merges: data.mergesLastHour.count as number | null, switchesOn: data.switches };
}

export function describeFleetRuns(b: FleetRunsBadge): string {
  const merges = b.merges === null ? 'merges unknown' : `${b.merges} merged last hour`;
  const switches = b.switchesOn.length ? ` · switches on: ${b.switchesOn.join(', ')}` : '';
  return `${b.workers} ${b.workers === 1 ? 'worker' : 'workers'} running · ${merges}${switches}`;
}

let missing: ApiError | null = null;
export const fleetRunsBadgeQuery: QueryDef<FleetRunsResponse> = {
  key: 'verse-fleet-runs-badge',
  fetch: async signal => {
    if (missing) throw missing;
    try {
      return await apiGet<FleetRunsResponse>('/api/verse/fleet/runs', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};

const subscribeVisibility = (listener: () => void): (() => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** One shared query; no background polling or retries for a missing route. */
export function useFleetRunsBadge(): FleetRunsBadge | null {
  const isVisible = useSyncExternalStore(subscribeVisibility, visible, () => true);
  const query = useQuery(fleetRunsBadgeQuery, { enabled: isVisible });
  const refetch = useRefetch(fleetRunsBadgeQuery);
  useEffect(() => {
    if (!isVisible || missing) return;
    const timer = setInterval(() => { if (!missing) refetch(); }, 10_000);
    return () => clearInterval(timer);
  }, [isVisible, refetch, query.error]);
  const current = isVisible ? query : getQuerySnapshot<FleetRunsResponse>(fleetRunsBadgeQuery.key);
  return missing ? null : fleetRunsBadge(current.data);
}
