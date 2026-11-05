/** Chief-of-staff reply drafts waiting for Mason's approval (GET/POST /api/verse/cos/drafts). */
export const COS_DRAFTS_PATH = '/api/verse/cos/drafts';
export const COS_APPROVE_PATH = '/api/verse/cos/drafts/approve';

export type CosDelivery = 'pending' | 'sending' | 'sent' | 'uncertain';

export interface CosDraft {
  id: string;
  channel: string;
  senderId: string;
  threadId?: string;
  text: string;
  digest: string;
  delivery: CosDelivery;
  draftedAt: string;
}

export const COS_ID_RE = /^cos-[a-f0-9]{32}$/;
export const COS_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DELIVERIES: readonly string[] = ['pending', 'sending', 'sent', 'uncertain'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readDraft(row: unknown): CosDraft | null {
  if (!isRecord(row)) return null;
  const { id, channel, senderId, threadId, text, digest, delivery, draftedAt } = row;
  if (typeof id !== 'string' || !COS_ID_RE.test(id)) return null;
  if (typeof digest !== 'string' || !COS_DIGEST_RE.test(digest)) return null;
  if (typeof channel !== 'string' || !channel || typeof senderId !== 'string' || !senderId) return null;
  if (typeof text !== 'string' || typeof draftedAt !== 'string') return null;
  if (typeof delivery !== 'string' || !DELIVERIES.includes(delivery)) return null;
  if (threadId !== undefined && typeof threadId !== 'string') return null;
  return { id, channel, senderId, ...(threadId !== undefined ? { threadId } : {}), text, digest, delivery: delivery as CosDelivery, draftedAt };
}

/** Strict narrowing: rows that fail the shape are dropped, never repaired. */
export function readCosDrafts(data: unknown): CosDraft[] {
  if (!isRecord(data) || data.v !== 1 || !Array.isArray(data.drafts)) return [];
  return data.drafts.map(readDraft).filter((draft): draft is CosDraft => draft !== null);
}

/** Drafts that can still be approved, newest first. */
export function pendingDrafts(drafts: readonly CosDraft[]): CosDraft[] {
  return drafts.filter(draft => draft.delivery === 'pending')
    .sort((a, b) => (a.draftedAt < b.draftedAt ? 1 : a.draftedAt > b.draftedAt ? -1 : 0));
}

/** Drafts the server may have already sent: shown with a note, never with a button. */
export function inFlightDrafts(drafts: readonly CosDraft[]): CosDraft[] {
  return drafts.filter(draft => draft.delivery === 'sending' || draft.delivery === 'uncertain');
}

const CHANNEL_NAMES: Record<string, string> = { telegram: 'Telegram', email: 'Email' };
export function cosChannelName(channel: string): string {
  return CHANNEL_NAMES[channel.toLowerCase()] ?? channel;
}

export function cosCheckNote(delivery: CosDelivery): string {
  return delivery === 'sending' ? 'Sending now; check the channel before doing anything else.'
    : 'Delivery is uncertain; check the channel.';
}

/** One plain sentence for every approve response. `body` is the parsed JSON body, or the ApiError code. */
export function approveOutcomeText(status: number, body: unknown, channel = ''): string {
  const record = isRecord(body) ? body : {};
  const code = typeof record.code === 'string' ? record.code : '';
  if (status === 200 && record.delivery === 'sent') return channel ? `Sent on ${cosChannelName(channel)}.` : 'Sent.';
  if (status === 409) {
    if (code === 'COS_DIGEST_STALE') return 'The draft changed; review it again.';
    if (code === 'COS_ALREADY_CLAIMED') return 'Already being sent.';
    if (code === 'COS_NO_TRANSPORT') return 'No reply route for desktop orders yet.';
  }
  if (status === 403 && code === 'COS_APPROVE_DESKTOP_ONLY') return 'Approve from the desktop app.';
  if (status === 404) return 'Reply approval is not in this build.';
  if (status === 502 || record.delivery === 'uncertain') return 'Send failed; check the channel before retrying.';
  return 'The draft could not be approved. Refresh and try again.';
}
