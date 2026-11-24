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
 * The earliest dated reply written after the entry, or null. The leader answers
 * every Mason line in one "Reply for Mason" block, so a later dated reply is the
 * ack; naming the entry is not required. Undated replies and undated entries
 * never count: neither can be shown to come after the other.
 */
export function answeringReply(entry: AckEntryRef, replies: readonly AckReply[]): AckReply | null {
  const stamp = inboxEntryTimestamp(entry.raw);
  const entryMs = stamp ? replyTime(stamp) : NaN;
  if (!Number.isFinite(entryMs)) return null;
  let best: AckReply | null = null;
  let bestMs = Infinity;
  for (const reply of replies) {
    const replyMs = replyTime(reply.at);
    if (Number.isFinite(replyMs) && replyMs > entryMs && replyMs < bestMs) { best = reply; bestMs = replyMs; }
  }
  return best;
}

/** Plain reason for an entry whose source has no way to carry an ack back. */
export function noChannelReason(source: string | null): string {
  return `came from ${source ?? 'an unlabelled source'}; no reply channel wired, answered in PLAN-LOG`;
}
