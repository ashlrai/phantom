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
/** A reply whose `at` stamp `replyTime` already resolved once — the bulk read
 * resolves every reply instant up front instead of re-parsing per entry. */
export interface AckReplyTimed extends AckReply { ms: number }

/** The timestamp an inbox entry opens with: ISO form, or the `YYYY-MM-DD HH:MM` of a legacy heading. */
export function inboxEntryTimestamp(raw: string): string | null {
  return /^(\d{4}-\d{2}-\d{2}T\S+)\s/.exec(raw)?.[1] ?? /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(raw)?.[1] ?? null;
}

/** The entry's own instant in ms, or NaN when its stamp cannot be read. */
export function inboxEntryMs(raw: string): number {
  const stamp = inboxEntryTimestamp(raw);
  return stamp ? replyTime(stamp) : NaN;
}

/**
 * The earliest reply instant strictly after `entryMs`, or null — the one
 * comparison `answeringReply` and the bulk ack read share. Undated replies
 * (`ms` NaN) and an unreadable entry instant never count: neither can be
 * shown to come after the other.
 */
export function answeringReplyTimed(entryMs: number, replies: readonly AckReplyTimed[]): AckReply | null {
  if (!Number.isFinite(entryMs)) return null;
  let best: AckReply | null = null;
  let bestMs = Infinity;
  for (const reply of replies) {
    if (Number.isFinite(reply.ms) && reply.ms > entryMs && reply.ms < bestMs) { best = reply; bestMs = reply.ms; }
  }
  return best;
}

/**
 * The earliest dated reply written after the entry, or null. The leader answers
 * every Mason line in one "Reply for Mason" block, so a later dated reply is the
 * ack; naming the entry is not required. Undated replies and undated entries
 * never count: neither can be shown to come after the other.
 */
export function answeringReply(entry: AckEntryRef, replies: readonly AckReply[]): AckReply | null {
  return answeringReplyTimed(inboxEntryMs(entry.raw),
    replies.map(reply => ({ ...reply, ms: replyTime(reply.at) })));
}

/** Plain reason for an entry whose source has no way to carry an ack back. */
export function noChannelReason(source: string | null): string {
  return `came from ${source ?? 'an unlabelled source'}; no reply channel wired, answered in PLAN-LOG`;
}
