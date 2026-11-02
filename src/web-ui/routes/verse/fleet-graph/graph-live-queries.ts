import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const liveStates = ['exhausted', 'held', 'stale', 'unknown', 'limited', 'ready', 'untracked'] as const;
export type GraphLiveState = typeof liveStates[number];
export interface GraphLiveData {
  v: 1;
  live: {
    nodes: Array<{ id: string; kind: string; live: {
      state: GraphLiveState; usedPercent: number | null; resetsAtMs: number | null;
      readingAgeMs: number | null; stale: boolean; reasons: string[];
    } }>;
    complete?: boolean;
    issues?: Array<{ code: string; nodeIds: string[] }>;
  };
}

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const numberOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));
const strings = (x: unknown) => Array.isArray(x) && x.every(item => typeof item === 'string');

export function narrowGraphLive(x: unknown): GraphLiveData | null {
  if (!record(x) || x.v !== 1 || !record(x.live) || !Array.isArray(x.live.nodes)
    || !x.live.nodes.every(node => record(node) && typeof node.id === 'string' && typeof node.kind === 'string'
      && record(node.live) && typeof node.live.state === 'string' && liveStates.includes(node.live.state as GraphLiveState)
      && numberOrNull(node.live.usedPercent) && numberOrNull(node.live.resetsAtMs) && numberOrNull(node.live.readingAgeMs)
      && typeof node.live.stale === 'boolean' && strings(node.live.reasons))
    || (x.live.complete !== undefined && typeof x.live.complete !== 'boolean')
    || (x.live.issues !== undefined && (!Array.isArray(x.live.issues)
      || !x.live.issues.every(issue => record(issue) && typeof issue.code === 'string' && strings(issue.nodeIds))))) return null;
  return x as unknown as GraphLiveData;
}

// A missing route stays missing for this page lifetime, including remounts.
let missing: ApiError | null = null;
export const graphLiveMissing = () => missing !== null;
export const graphLiveQuery: QueryDef<GraphLiveData | null> = {
  key: 'verse-fleet-graph-live',
  fetch: async signal => {
    if (missing) throw missing;
    try {
      return narrowGraphLive(await apiGet<unknown>('/api/verse/fleet/graph/live', signal));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};
