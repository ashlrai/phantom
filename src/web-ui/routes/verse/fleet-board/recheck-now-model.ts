import { formatRelative } from '../autonomy/format.js';

/**
 * Outcome of POST /api/verse/fleet/recheck/record, reduced to what the button
 * needs. Local shape on purpose: the web bundle must not import src/core.
 */
export type RecheckNowResult =
  | { ok: true; recorded: unknown }
  | { ok: false; status: number; reason?: string | null };

const STATES = ['VERIFIED', 'UNKNOWN', 'BLOCKED'];
const MAX_REASON = 120;

const failed = (reason: string | null | undefined): string => {
  const clean = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  return `Record failed: ${(clean || 'unknown reason').slice(0, MAX_REASON)}`;
};

/** One plain-text line for any outcome. The 200 payload is validated, never trusted. */
export function describeRecheckNow(result: RecheckNowResult, now: number = Date.now()): string {
  if (result.ok) {
    const rec = result.recorded && typeof result.recorded === 'object' ? (result.recorded as Record<string, unknown>) : null;
    if (!rec || typeof rec.overall !== 'string' || !STATES.includes(rec.overall)) return failed('server answered with an unreadable record');
    const asOf = typeof rec.asOf === 'string' ? rec.asOf : null;
    return `Recorded ${rec.overall} as of ${formatRelative(asOf, now)}`;
  }
  switch (result.status) {
    case 404:
    case 405: return 'Recheck now is not on this Phantom build';
    case 409: return 'A recheck is already running';
    case 503: return 'Recheck unavailable right now';
    default: return failed(result.reason);
  }
}
