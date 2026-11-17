import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Kept local to the web bundle; the report is narrowed at the display boundary. */
export interface PeerLedgerResponse {
  v: unknown;
  authority: unknown;
  generatedAt: unknown;
  report: unknown;
}

/** Server route; the web bundle cannot import src/core, so a test pins this to VERSE_FLEET_PEER_LEDGER_PATH. */
export const PEER_LEDGER_PATH = '/api/verse/fleet/peer-ledger';

/**
 * The server answers with the bare report (`{ v, authority, status, asOf, ... }`).
 * Wrap it for `parsePeerLedger`, copying `v`/`authority` through untouched so the
 * model's strict envelope checks still decide whether the body is trusted.
 */
function toEnvelope(body: unknown): PeerLedgerResponse {
  const r = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { v: r.v, authority: r.authority, generatedAt: r.asOf, report: body };
}

export const peerLedgerQuery: QueryDef<PeerLedgerResponse | null> = {
  key: 'verse-fleet-peer-ledger',
  async fetch(signal) {
    try {
      return toEnvelope(await apiGet<unknown>(PEER_LEDGER_PATH, signal));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
