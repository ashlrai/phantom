import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowTailnetPeers, type TailnetPeersView } from './tailnet-peers-model.js';

export const tailnetPeersQuery: QueryDef<TailnetPeersView | null> = {
  key: 'verse-fleet-tailnet-peers',
  async fetch(signal) {
    try { return narrowTailnetPeers(await apiGet<unknown>('/api/verse/fleet/tailnet-peers', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
