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
  paused?: boolean | null;
  lanes?: Array<{ lane: string; held: boolean }>;
}

export interface FleetRunsBadge {
  workers: number;
  merges: number | null;
  switchesOn: string[];
  paused: boolean;
  heldLanes: string[];
  staleSeconds?: number;
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
  if (record(data.sources) && data.sources.runsDir === 'missing') return null;
  if (data.paused !== undefined && data.paused !== null && typeof data.paused !== 'boolean') return null;
  if (data.lanes !== undefined && (!Array.isArray(data.lanes) || !data.lanes.every(lane =>
    record(lane) && typeof lane.lane === 'string' && typeof lane.held === 'boolean'))) return null;
  const lanes = (data.lanes ?? []) as Array<{ lane: string; held: boolean }>;
  const names = new Set(lanes.map(lane => lane.lane));
  const heldLanes = lanes.filter(lane => lane.held).map(({ lane }) => {
    const short = lane.startsWith('codex-') ? lane.slice(6) : lane;
    return short && !names.has(short) ? short : lane;
  }).sort();
  const badge = { workers: data.workers.length, merges: data.mergesLastHour.count as number | null, switchesOn: data.switches } as FleetRunsBadge;
  Object.defineProperties(badge, {
    paused: { value: data.paused === true, enumerable: data.paused !== undefined },
    heldLanes: { value: heldLanes, enumerable: data.lanes !== undefined },
  });
  return badge;
}

export function fleetRunsIdle(b: FleetRunsBadge): boolean {
  return b.workers === 0 && b.merges === 0;
}

export function fleetRunsTone(b: FleetRunsBadge): 'warning' | 'running' {
  return b.paused || b.heldLanes?.length || b.switchesOn.length || fleetRunsIdle(b) ? 'warning' : 'running';
}

export function fleetReadsFailingText(badge: FleetRunsBadge): string | null {
  return badge.staleSeconds !== undefined && badge.staleSeconds >= 60
    ? `fleet reads failing ${Math.floor(badge.staleSeconds / 60)} min` : null;
}

export function describeFleetRuns(b: FleetRunsBadge): string {
  const failing = fleetReadsFailingText(b);
  const merges = b.merges === null ? 'merges unknown' : `${b.merges} merged last hour`;
  const switches = b.switchesOn.length ? ` · switches on: ${b.switchesOn.join(', ')}` : '';
  return `${b.workers} ${b.workers === 1 ? 'worker' : 'workers'} running · ${merges}${switches}${fleetRunsIdle(b) ? ' · fleet idle' : ''}${b.paused ? ' · paused' : ''}${b.heldLanes?.length ? ` · held: ${b.heldLanes.join(', ')}` : ''}${failing ? ` · ${failing}` : ''}`;
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
  const badge = missing ? null : fleetRunsBadge(current.data);
  if (badge && current.error && current.updatedAt !== null) {
    Object.defineProperty(badge, 'staleSeconds', {
      value: Math.max(0, Math.floor((Date.now() - current.updatedAt) / 1000)), enumerable: false,
    });
  }
  return badge;
}
