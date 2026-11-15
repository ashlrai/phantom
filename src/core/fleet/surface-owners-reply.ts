/**
 * core/fleet/surface-owners-reply.ts: format surface-owner reports as one
 * short thread reply for the owner's "owners" ask. Pure: no I/O, no clock.
 * Every interpolated value is scrubbed here (sanitizeIdentityText), control
 * characters are stripped, and the whole reply is hard-capped. The reply is
 * evidence only: claims are advisory and nothing is assigned.
 */
import { sanitizeIdentityText } from './runtime-identity.js';
import type { SurfaceOwnerReport } from './surface-owner.js';

const REPLY_MAX = 900;
const FOOTER = 'Claims are advisory; this reply assigns nothing.';
const HOME_PATH = /\/(?:Users|home)\/[^/\s;,)]+/g;
const CONTROL = /\p{Cc}/gu;
/** ESC-led CSI sequences are removed whole so no `[31m` residue remains. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function scrub(value: unknown): string {
  const text = String(value ?? '').replace(ANSI, '').replace(CONTROL, ' ').replace(HOME_PATH, '~');
  return sanitizeIdentityText(text, '').trim();
}

function line(r: SurfaceOwnerReport): string {
  const surface = scrub(r?.surface) || 'unknown';
  const claims = Array.isArray(r?.liveClaims) ? r.liveClaims : [];
  if (claims.length > 1) return `${surface}: ${claims.length} live claims, contested`;
  if (r?.ownerSource === 'advisory-claim' && claims.length === 1) {
    const mins = Math.max(0, Math.ceil((Number(claims[0]!.expiresInSeconds) || 0) / 60));
    return `${surface}: ${scrub(r.owner) || 'UNKNOWN'} (advisory claim, expires in ${mins}m)`;
  }
  const reasons = Array.isArray(r?.reasons) ? r.reasons : [];
  if (reasons.length > 0 && (reasons.some(x => String(x).startsWith('coordination ledger')))) {
    return `${surface}: UNKNOWN (${scrub(reasons[0]) || 'unreadable'})`;
  }
  const l = r?.lastLanded;
  if (l) return `${surface}: no live owner — last landed ${scrub(l.jobId)} #${l.pr ?? '?'} ${scrub(l.date).slice(0, 10)}`;
  return `${surface}: no live owner — no landed history read`;
}

export function formatSurfaceOwnersReply(reports: SurfaceOwnerReport[], asOf: string): string {
  const head = `Phantom owners, as of ${scrub(asOf) || 'unknown'}`;
  const body = (Array.isArray(reports) ? reports : []).map(line);
  const full = [head, ...body, FOOTER].join('\n');
  if (full.length <= REPLY_MAX) return full;
  const tail = `…\n${FOOTER}`;
  return `${[head, ...body].join('\n').slice(0, REPLY_MAX - tail.length)}${tail}`;
}
