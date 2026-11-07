/**
 * Cross-channel dedupe for MASON-INBOX.md (pure; no I/O).
 *
 * The same instruction sent from two surfaces (phone page + Telegram, desktop
 * box + email) must land once, attributed to every source. A duplicate is the
 * same normalized text (trim, collapse whitespace, case-fold; no fuzzy match)
 * from the same verified sender, received inside CROSS_CHANNEL_WINDOW_MS of the
 * entry. Different senders never merge. An entry that already carries the
 * incoming channel is a same-channel repeat: the caller's existing idempotent
 * path applies, so this returns `append` (no merge) for it.
 */

export const CROSS_CHANNEL_WINDOW_MS = 10 * 60 * 1000;

export interface DedupeEnvelope {
  text: string;
  channel: string;
  /** Authenticated canonical sender id. Never written to the inbox. */
  senderId: string;
  /** Epoch milliseconds. */
  receivedAt: number;
}

export interface RecentInboxEntry {
  id: string;
  /** Verified sender of the entry; undefined when unproven, which never merges. */
  senderId?: string;
  text: string;
  /** Epoch milliseconds. */
  receivedAt: number;
  /** Every source already attributed to the entry. */
  channels: readonly string[];
}

export type CrossChannelDecision =
  | { action: 'append' }
  | { action: 'merge'; entryId: string; addSource: string };

export function normalizeForDedupe(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function decideCrossChannelMerge(envelope: DedupeEnvelope, recent: readonly RecentInboxEntry[]): CrossChannelDecision {
  const wanted = normalizeForDedupe(envelope.text);
  if (!wanted) return { action: 'append' };
  let newest: RecentInboxEntry | undefined;
  for (const entry of recent) {
    const age = envelope.receivedAt - entry.receivedAt;
    if (entry.senderId === undefined || entry.senderId !== envelope.senderId) continue;
    if (!(age >= 0 && age < CROSS_CHANNEL_WINDOW_MS)) continue;
    if (normalizeForDedupe(entry.text) !== wanted) continue;
    if (!newest || entry.receivedAt >= newest.receivedAt) newest = entry;
  }
  if (!newest || newest.channels.includes(envelope.channel)) return { action: 'append' };
  return { action: 'merge', entryId: newest.id, addSource: envelope.channel };
}
