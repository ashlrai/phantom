import type { BusInboxPage } from '../../../../core/fleet/bus-inbox.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export type AgentBusMapPage = Extract<BusInboxPage, { status: 'ok' }> & { v: 1 };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Validate the fields used by the map before accepting an untrusted response. */
export function narrowAgentBusMapPage(value: unknown): AgentBusMapPage | null {
  if (!record(value) || value.v !== 1 || value.status !== 'ok' || !count(value.nextCursor)
    || !Array.isArray(value.messages) || value.messages.length > 100
    || !value.messages.every(receipt => {
      if (!record(receipt) || !count(receipt.cursor) || receipt.cursor === 0 || !count(receipt.receivedAt)
        || receipt.receivedAt > 8_640_000_000_000_000 || !record(receipt.envelope)) return false;
      const envelope = receipt.envelope;
      return typeof envelope.id === 'string' && typeof envelope.from === 'string' && typeof envelope.to === 'string'
        && (envelope.priority === 'P0' || envelope.priority === 'P1' || envelope.priority === 'P2' || envelope.priority === 'P3')
        && count(envelope.ttl) && envelope.ttl > 0 && Object.hasOwn(envelope, 'body');
    })) return null;
  return value as unknown as AgentBusMapPage;
}

export const agentBusMapQuery: QueryDef<AgentBusMapPage | null> = {
  key: 'verse-agent-bus-map',
  fetch: async signal => {
    try {
      const page = narrowAgentBusMapPage(await apiGet<unknown>('/api/verse/agent-bus?after=0&limit=100', signal));
      if (!page) throw new Error('Invalid durable bus page');
      return page;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
      throw error;
    }
  },
};
