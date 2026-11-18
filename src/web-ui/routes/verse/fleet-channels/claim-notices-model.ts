/** Narrowed view for GET /api/verse/fleet/control/claim-notices. Never throws. */
export type ClaimNoticeSource = 'ok' | 'missing' | 'unreadable';
export type ClaimNoticeDeliveryWord = 'slack-sent' | 'no-slack-receipt' | 'unknown';
export interface ClaimNoticesDelivery {
  sendStore: 'ok' | 'missing' | 'degraded' | 'unknown';
  slackSent: number;
  noReceipt: number;
  unknown: number;
}
export interface ClaimNoticesView {
  source: ClaimNoticeSource;
  bindings: number;
  sentTotal: number;
  recent: Array<{ state: string; claimId: string; at: number; delivery: ClaimNoticeDeliveryWord }>;
  delivery: ClaimNoticesDelivery;
  pending: Array<{ state: string; threadKey: string; text: string }>;
  /** Live claims whose notices are dropped for want of a bound thread. */
  unbound: { state: 'known' | 'unknown'; total: number;
    rows: Array<{ claimId: string; repo: string; agent: string; claimedAt: number }> };
  slackConfigured: boolean | 'unknown';
  /** Server `generatedAt`, only when it parses; null reads as "as of unknown". */
  asOf: string | null;
  /** Under 'unknown', `pending` carries no information: an empty list is not "0 waiting". */
  pendingObservation: { state: 'known' } | { state: 'unknown'; reason: string };
}

const PENDING_REASONS = ['state-missing', 'ledger-unavailable', 'board-unavailable',
  'bindings-unavailable', 'prev-unavailable', 'observation-failed'];

export const CLAIM_NOTICE_ROWS = 20;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const str = (v: unknown): string => typeof v === 'string' ? v.slice(0, 300) : '';
/** An older server sends no `delivery` field: evidence absent reads as unknown, never as success. */
const word = (v: unknown): ClaimNoticeDeliveryWord =>
  v === 'slack-sent' || v === 'no-slack-receipt' || v === 'unknown' ? v : 'unknown';
const sendStore = (v: unknown): ClaimNoticesDelivery['sendStore'] =>
  v === 'ok' || v === 'missing' || v === 'degraded' ? v : 'unknown';

/** A missing or malformed field (old server) reads as unknown, never as "none". */
function narrowUnbound(raw: unknown): ClaimNoticesView['unbound'] {
  const unknown = { state: 'unknown' as const, total: 0, rows: [] };
  if (!object(raw) || raw.state !== 'known' || !Array.isArray(raw.rows)) return unknown;
  const rows = raw.rows.slice(0, CLAIM_NOTICE_ROWS).flatMap(row =>
    object(row) && str(row.claimId) && str(row.repo) && str(row.agent)
      && typeof row.claimedAt === 'number' && Number.isFinite(row.claimedAt)
      ? [{ claimId: str(row.claimId), repo: str(row.repo), agent: str(row.agent), claimedAt: row.claimedAt }] : []);
  return { state: 'known', total: Math.max(count(raw.total), rows.length), rows };
}

/** Known only on an explicit `known`; a missing field (old server) or any other shape stays unknown. */
function narrowPendingObservation(raw: unknown): ClaimNoticesView['pendingObservation'] {
  if (object(raw) && raw.state === 'known') return { state: 'known' };
  const reason = object(raw) && typeof raw.reason === 'string' && PENDING_REASONS.includes(raw.reason)
    ? raw.reason : 'not-reported';
  return { state: 'unknown', reason };
}

export function narrowClaimNotices(raw: unknown): ClaimNoticesView | null {
  if (!object(raw) || raw.v !== 1) return null;
  if (raw.source !== 'ok' && raw.source !== 'missing' && raw.source !== 'unreadable') return null;
  const sent = object(raw.sent) ? raw.sent : {};
  const recent = (Array.isArray(sent.recent) ? sent.recent : []).slice(0, CLAIM_NOTICE_ROWS).flatMap(row =>
    object(row) && str(row.state) && str(row.claimId) && typeof row.at === 'number' && Number.isFinite(row.at)
      ? [{ state: str(row.state), claimId: str(row.claimId), at: row.at, delivery: word(row.delivery) }] : []);
  const summary = object(raw.delivery)
    ? { sendStore: sendStore(raw.delivery.sendStore), slackSent: count(raw.delivery.slackSent),
        noReceipt: count(raw.delivery.noReceipt), unknown: count(raw.delivery.unknown) }
    : { sendStore: 'unknown' as const, slackSent: recent.filter(r => r.delivery === 'slack-sent').length,
        noReceipt: recent.filter(r => r.delivery === 'no-slack-receipt').length,
        unknown: recent.filter(r => r.delivery === 'unknown').length };
  const pending = (Array.isArray(raw.pending) ? raw.pending : []).slice(0, CLAIM_NOTICE_ROWS).flatMap(row =>
    object(row) && str(row.state) ? [{ state: str(row.state), threadKey: str(row.threadKey), text: str(row.text) }] : []);
  return { source: raw.source, bindings: count(raw.bindings), sentTotal: count(sent.total), recent,
    delivery: summary, pending, unbound: narrowUnbound(raw.unbound),
    slackConfigured: typeof raw.slackConfigured === 'boolean' ? raw.slackConfigured : 'unknown',
    asOf: typeof raw.generatedAt === 'string' && !Number.isNaN(Date.parse(raw.generatedAt)) ? raw.generatedAt : null,
    pendingObservation: narrowPendingObservation(raw.pendingObservation) };
}
