import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export type BusKind = 'inbox' | 'orch' | 'incident' | 'lane-hold' | 'launch' | 'published' | 'other';
export interface BusHop { id: string; from: string; to: string; inputTokens: number | null; outputTokens: number | null }
export interface BusEvent { at: string; kind: BusKind; text: string }
type Source = 'healthy' | 'missing' | 'degraded';
export interface BusFeedData {
  v: 1;
  hops: BusHop[];
  hopsDropped: number;
  lastHopAt: string | null;
  events: BusEvent[];
  sources: { hops: Source; events: Source };
}
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const tokens = (x: unknown) => x === null || count(x);
const timestamp = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
const source = (x: unknown) => x === 'healthy' || x === 'missing' || x === 'degraded';
const kinds: readonly string[] = ['inbox', 'orch', 'incident', 'lane-hold', 'launch', 'published', 'other'];

export function narrowBusFeed(x: unknown): BusFeedData | null {
  if (!record(x) || x.v !== 1 || !count(x.hopsDropped)
    || !(x.lastHopAt === null || timestamp(x.lastHopAt))
    || !Array.isArray(x.hops) || !x.hops.every(h => record(h) && typeof h.id === 'string'
      && typeof h.from === 'string' && typeof h.to === 'string' && tokens(h.inputTokens) && tokens(h.outputTokens))
    || !Array.isArray(x.events) || !x.events.every(e => record(e) && timestamp(e.at)
      && typeof e.kind === 'string' && kinds.includes(e.kind) && typeof e.text === 'string')
    || !record(x.sources) || !source(x.sources.hops) || !source(x.sources.events)) return null;
  return x as unknown as BusFeedData;
}

// A missing route stays missing for this page lifetime, including remounts.
let missing: ApiError | null = null;
export const busFeedMissing = () => missing !== null;
export const busFeedQuery: QueryDef<BusFeedData | null> = {
  key: 'verse-fleet-bus-feed',
  fetch: async signal => {
    if (missing) throw missing;
    try {
      return narrowBusFeed(await apiGet<unknown>('/api/verse/fleet/live/bus?limit=50', signal));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};
