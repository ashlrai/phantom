/** Reply to a teammate text from the Waiting list (POST /api/verse/comms/teammate-reply). */
import type { UnifiedInboxEntry } from './unified-inbox-model.js';

export const TEAMMATE_REPLY_PATH = '/api/verse/comms/teammate-reply';

const ID_PREFIX = 'imessage:teammate-';

/** The stored rowid behind a teammate-text item id, or null for any other item. */
export function teammateRowid(item: Pick<UnifiedInboxEntry, 'id' | 'kind'>): number | null {
  if (item.kind !== 'teammate-text' || !item.id.startsWith(ID_PREFIX)) return null;
  const digits = item.id.slice(ID_PREFIX.length);
  if (!/^[1-9]\d{0,15}$/.test(digits)) return null;
  const rowid = Number(digits);
  return Number.isSafeInteger(rowid) ? rowid : null;
}

/** One plain sentence for a reply attempt. `status` is the HTTP status; `body` the parsed JSON when there was one. */
export function teammateReplyOutcome(status: number, body: unknown): string {
  const code = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
  if (status === 200 && code === 'sent') return 'Sent.';
  if (status === 403) return 'Not sent: this teammate is not allowed by your comms settings.';
  if (status === 202 && code === 'uncertain') return 'Sent status unknown; check Messages before sending again.';
  if (status === 404) return 'That text was already answered.';
  return 'Could not send. Try again.';
}
