import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Kept local to the web bundle; the report is narrowed at the display boundary. */
export interface PeerLedgerResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  report: unknown;
}

export const peerLedgerQuery: QueryDef<PeerLedgerResponse | null> = {
  key: 'verse-fleet-peer-ledger',
  async fetch(signal) {
    try {
      return await apiGet<PeerLedgerResponse>('/api/verse/fleet/runtime-identity/peer-ledger', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
