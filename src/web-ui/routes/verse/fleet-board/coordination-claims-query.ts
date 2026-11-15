import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Narrowed read of GET /api/verse/fleet/coordination-claims (advisory ledger). */
export interface CoordLedgerClaim { agent: string; repo: string; task: string; expiresInSeconds: number | null; }
export interface CoordLedgerView {
  /** Server state ('known' | 'unknown'); anything unrecognised narrows to 'unknown'. */
  state: string;
  generatedAt: string | null;
  claims: CoordLedgerClaim[];
  expiredClaims: number | null;
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v !== '' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Malformed fields narrow to null / 'unknown', never to 0. */
export function narrowCoordLedger(raw: unknown): CoordLedgerView {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.claims) ? o.claims : [];
  const claims = list
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      agent: str(c.agent, 'unknown'), repo: str(c.repo, 'unknown'), task: str(c.task, 'unknown'),
      expiresInSeconds: num(c.expiresInSeconds),
    }));
  return {
    state: o.state === 'known' ? 'known' : 'unknown',
    generatedAt: typeof o.generatedAt === 'string' && o.generatedAt !== '' ? o.generatedAt : null,
    claims,
    expiredClaims: num(o.expiredClaims),
  };
}

export const coordinationClaimsQuery: QueryDef<CoordLedgerView | null> = {
  key: 'verse-fleet-coordination-claims',
  async fetch(signal) {
    try { return narrowCoordLedger(await apiGet<unknown>('/api/verse/fleet/coordination-claims', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
