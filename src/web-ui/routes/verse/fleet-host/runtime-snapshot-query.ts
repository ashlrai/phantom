import { elapsedTime } from '../../../lib/relative-time.js';
import { apiGet, ApiError, readFailureReason } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/**
 * Response shape for GET /api/verse/fleet/runtime-identity/snapshot. Declared
 * here on purpose: the route is a separate change (RQ-PHX-RUNTIMESNAPSHOTROUTE384)
 * and no web-side type may be imported from src/core/verse. Numeric fields may
 * arrive as the string 'UNKNOWN'; coordinationLine reads every field defensively.
 */
export interface RuntimeSnapshotResponse {
  v: number;
  authority: string;
  generatedAt: string;
  snapshot: {
    host: string;
    tailnetName: string;
    installedVersion: string;
    sourceVersion?: string;
    lastFleetStateRead: { mtime: string; ageSeconds: number | string };
    coordination: {
      state: string;
      activeClaims: number | string;
      newestReturnAgeSeconds: number | string;
      reason?: string;
    };
    asOf: string;
    reasons: string[];
  };
}

export interface CoordinationLine {
  text: string;
  tone: 'ok' | 'unknown';
}

export const runtimeSnapshotQuery: QueryDef<RuntimeSnapshotResponse> = {
  key: 'verse-fleet-runtime-snapshot',
  fetch: (signal) => apiGet<RuntimeSnapshotResponse>('/api/verse/fleet/runtime-identity/snapshot', signal),
};

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Compact duration for the "… ago" slot: 45s, 5m, 3h, 2d. */
function agoText(seconds: number): string {
  return elapsedTime(seconds);
}

/** Local hh:mm for the "as of" slot; 'unknown' when the timestamp won't parse. */
function clockText(asOf: unknown): string {
  const ms = typeof asOf === 'string' ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(ms)) return 'unknown';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The one Coordination row under the identity rows. Honest states only: a 404
 * means this build does not serve the route, a fetch failure says so, and any
 * value the snapshot leaves UNKNOWN prints 'unknown' — never a guessed zero.
 */
export function coordinationLine(resp: RuntimeSnapshotResponse | undefined, error?: unknown): CoordinationLine {
  if (resp === undefined) {
    if (error instanceof ApiError && error.status === 404) return { text: 'Coordination: not served by this build', tone: 'unknown' };
    if (error !== undefined) return { text: `Coordination: read failed (${readFailureReason(error)})`, tone: 'unknown' };
    return { text: 'Coordination: reading…', tone: 'unknown' };
  }
  const snap: Record<string, unknown> = object(resp.snapshot) ? resp.snapshot : {};
  const c: Record<string, unknown> = object(snap.coordination) ? snap.coordination : {};
  const known = c.state === 'known';
  const claims = known && isCount(c.activeClaims) ? c.activeClaims : 'unknown';
  const ageSeconds = known && isCount(c.newestReturnAgeSeconds) ? c.newestReturnAgeSeconds : 'unknown';
  const tailnet = typeof snap.tailnetName === 'string' && snap.tailnetName !== '' ? snap.tailnetName : 'unknown';
  const asOf = clockText(snap.asOf);
  let reason = typeof c.reason === 'string' ? c.reason : '';
  if (reason === '' && Array.isArray(snap.reasons)) reason = snap.reasons.find((r): r is string => typeof r === 'string' && r !== '') ?? '';
  const text = [
    claims === 'unknown' ? 'unknown live claims' : `${claims} live ${claims === 1 ? 'claim' : 'claims'}`,
    ageSeconds === 'unknown' ? 'newest return unknown' : `newest return ${agoText(ageSeconds)} ago`,
    `tailnet ${tailnet}`,
    `as of ${asOf}`,
  ].join(' · ');
  const tone: CoordinationLine['tone'] = claims !== 'unknown' && ageSeconds !== 'unknown' && tailnet !== 'unknown' && asOf !== 'unknown' ? 'ok' : 'unknown';
  return { text: tone === 'unknown' && reason !== '' ? `${text} (${reason})` : text, tone };
}
