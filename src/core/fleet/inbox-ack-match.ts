/**
 * Does a leader reply answer a MASON-INBOX entry? The leader answers in PLAN-LOG
 * ("Reply for Mason") and cannot write MASON-OUTBOX, so a reply that names the
 * entry's id or timestamp counts as the ack. Pure: no I/O, no clock.
 */
import { replyTime } from './mason-outbox.js';

export interface AckEntryRef {
  entryId: string;
  /** Raw entry, used to read its timestamp. */
  raw: string;
}
export interface AckReply { at: string; text: string }

/** The timestamp an inbox entry opens with: ISO form, or the `YYYY-MM-DD HH:MM` of a legacy heading. */
export function inboxEntryTimestamp(raw: string): string | null {
  return /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(raw)?.[1] ?? /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(raw)?.[1] ?? null;
}

/**
 * True when a reply written at or after the entry names its id or timestamp.
 * A reply with no readable time still counts: it cannot be shown to be earlier.
 */
export function isAnsweredByReplies(entry: AckEntryRef, replies: readonly AckReply[]): boolean {
  const stamp = inboxEntryTimestamp(entry.raw);
  const entryMs = stamp ? replyTime(stamp) : NaN;
  return replies.some(reply => {
    const replyMs = replyTime(reply.at);
    if (Number.isFinite(entryMs) && Number.isFinite(replyMs) && replyMs < entryMs) return false;
    return reply.text.includes(entry.entryId) || (stamp !== null && reply.text.includes(stamp));
  });
}

/** Plain reason for an entry whose source has no way to carry an ack back. */
export function noChannelReason(source: string | null): string {
  return `came from ${source ?? 'an unlabelled source'}; no reply channel wired, answered in PLAN-LOG`;
}
