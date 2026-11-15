/** Narrowed view for GET /api/verse/fleet/control/claim-notices. Never throws. */
export type ClaimNoticeSource = 'ok' | 'missing' | 'unreadable';
export interface ClaimNoticesView {
  source: ClaimNoticeSource;
  bindings: number;
  sentTotal: number;
  recent: Array<{ state: string; claimId: string; at: number }>;
  pending: Array<{ state: string; threadKey: string; text: string }>;
  slackConfigured: boolean | 'unknown';
}

export const CLAIM_NOTICE_ROWS = 20;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const str = (v: unknown): string => typeof v === 'string' ? v.slice(0, 300) : '';

export function narrowClaimNotices(raw: unknown): ClaimNoticesView | null {
  if (!object(raw) || raw.v !== 1) return null;
  if (raw.source !== 'ok' && raw.source !== 'missing' && raw.source !== 'unreadable') return null;
  const sent = object(raw.sent) ? raw.sent : {};
  const recent = (Array.isArray(sent.recent) ? sent.recent : []).slice(0, CLAIM_NOTICE_ROWS).flatMap(row =>
    object(row) && str(row.state) && str(row.claimId) && typeof row.at === 'number' && Number.isFinite(row.at)
      ? [{ state: str(row.state), claimId: str(row.claimId), at: row.at }] : []);
  const pending = (Array.isArray(raw.pending) ? raw.pending : []).slice(0, CLAIM_NOTICE_ROWS).flatMap(row =>
    object(row) && str(row.state) ? [{ state: str(row.state), threadKey: str(row.threadKey), text: str(row.text) }] : []);
  return { source: raw.source, bindings: count(raw.bindings), sentTotal: count(sent.total), recent, pending,
    slackConfigured: typeof raw.slackConfigured === 'boolean' ? raw.slackConfigured : 'unknown' };
}
