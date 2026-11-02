import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

interface BusReceipt {
  cursor: number;
  receivedAt: number;
  envelope: { id: string; from: string; to: string; priority: 'P0' | 'P1' | 'P2' | 'P3'; ttl: number; body: unknown };
}
interface BusPage { v: 1; status: 'ok'; messages: BusReceipt[]; nextCursor: number; timestamp?: unknown }
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const json = (x: unknown): boolean => x === null || typeof x === 'string' || typeof x === 'boolean'
  || (typeof x === 'number' && Number.isFinite(x)) || (Array.isArray(x) && x.every(json))
  || (record(x) && Object.values(x).every(json));

export function narrowBusFeedPage(x: unknown): BusPage | null {
  if (!record(x) || x.v !== 1 || x.status !== 'ok' || !count(x.nextCursor) || !Array.isArray(x.messages)
    || !x.messages.every(row => record(row) && count(row.cursor) && row.cursor > 0 && count(row.receivedAt)
      && row.receivedAt <= 8_640_000_000_000_000 && record(row.envelope)
      && typeof row.envelope.id === 'string' && typeof row.envelope.from === 'string' && typeof row.envelope.to === 'string'
      && ['P0', 'P1', 'P2', 'P3'].includes(String(row.envelope.priority))
      && count(row.envelope.ttl) && row.envelope.ttl > 0 && json(row.envelope.body))) return null;
  return x as unknown as BusPage;
}

// An older hub without this route is not probed again during this page lifetime.
let missing: ApiError | null = null;
export const agentBusFeedQuery: QueryDef<unknown> = {
  key: 'verse-fleet-events-bus',
  fetch: async signal => {
    if (missing) throw missing;
    try { return narrowBusFeedPage(await apiGet<unknown>('/api/verse/agent-bus?after=0&limit=100', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};
