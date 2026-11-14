import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { formatRelative } from '../autonomy/format.js';

/**
 * Minimal local shape of GET /api/verse/fleet/recheck → `{ recheck: FleetRecheck }`.
 * Declared here on purpose: the web bundle must not import src/core.
 */
export interface RecheckResp {
  recheck?: {
    asOf?: string;
    overall?: { state?: string; missing?: string[] };
  };
}

/** `null` = the route is absent (404) on this build. */
export const recheckVerdictQuery: QueryDef<RecheckResp | null> = {
  key: 'verse-fleet-recheck',
  async fetch(signal) {
    try { return await apiGet<RecheckResp>('/api/verse/fleet/recheck', signal); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export interface RecheckLine { text: string; ok: boolean | 'unknown'; }

const PREFIX = 'Server recheck';
const MAX_REASON = 120;
const STATES = ['VERIFIED', 'UNKNOWN', 'BLOCKED'] as const;

/**
 * Input: `undefined` = still loading, `null` or `'error'` = route absent /
 * network failure, otherwise the parsed payload (validated here, not trusted).
 */
export function deriveRecheckLine(resp: RecheckResp | null | 'error' | undefined, now: number): RecheckLine {
  if (resp === undefined) return { text: `${PREFIX} · loading`, ok: 'unknown' };
  if (resp === null || resp === 'error') return { text: `${PREFIX} · not on this build`, ok: 'unknown' };

  const recheck = typeof resp === 'object' ? resp.recheck : undefined;
  const overall = recheck && typeof recheck === 'object' ? recheck.overall : undefined;
  const state = overall && typeof overall === 'object' ? overall.state : undefined;
  if (!STATES.includes(state as (typeof STATES)[number])) return { text: `${PREFIX} · unreadable`, ok: false };

  const asOf = typeof recheck?.asOf === 'string' ? recheck.asOf : null;
  const when = `as of ${formatRelative(asOf, now)}`;
  if (state === 'VERIFIED') return { text: `${PREFIX} · VERIFIED · ${when}`, ok: true };

  const first = Array.isArray(overall?.missing) ? overall.missing.find((m) => typeof m === 'string' && m !== '') : undefined;
  const reason = first === undefined ? [] : [first.length > MAX_REASON ? first.slice(0, MAX_REASON) : first];
  return { text: [PREFIX, state, ...reason, when].join(' · '), ok: state === 'BLOCKED' ? false : 'unknown' };
}
