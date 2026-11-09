/**
 * routes/verse/mobile/screens/leader-owner-model.ts — the owner thread (what
 * Mason sent over iMessage, Slack, Telegram, email or the desktop, and what
 * the Leader sent back) folded into the phone Leader screen's entries, in
 * time order. Pure. The labels and the desktop-mirror dedupe are the Leader
 * pane's own (leader-thread/owner-thread-lines.ts).
 */
import { ownerThreadLines } from '../../leader-thread/owner-thread-lines.js';
import type { OwnerThreadRead } from '../../leader-thread/owner-thread-queries.js';
import type { ThreadEntry } from '../../leader/thread-model.js';

export interface PhoneOwnerThread {
  entries: ThreadEntry[];
  /** Entry key → "Mason via iMessage" / "Leader → Slack, Desktop", for the owner lines. */
  labels: ReadonlyMap<string, string>;
}

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/** `entries` unchanged (same array) when the owner read adds nothing or is paused. */
export function mergeOwnerThread(entries: ThreadEntry[], read: OwnerThreadRead): PhoneOwnerThread {
  if (read.paused || read.lines.length === 0) return { entries, labels: NO_LABELS };
  const fleet = entries.flatMap((e) => (e.type === 'message' && e.message.from === 'mason'
    ? [{ at: Date.parse(e.at), who: 'mason' as const, source: e.message.channel, text: e.message.text, id: e.key, ack: null }]
    : []));
  const labels = new Map<string, string>();
  const owner = ownerThreadLines(read.lines, fleet).flatMap((line): ThreadEntry[] => {
    if (!line.label) return [];
    const at = new Date(line.at).toISOString();
    labels.set(line.id, line.label);
    return [{ type: 'message', key: line.id, at, message: { id: line.id, at, from: line.who, channel: 'verse', kind: 'message', text: line.text } }];
  });
  if (owner.length === 0) return { entries, labels: NO_LABELS };
  // Stable: an owner line sorts after an existing entry at the same instant.
  const merged = [...entries, ...owner].map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(a.e.at) - Date.parse(b.e.at) || a.i - b.i).map(({ e }) => e);
  return { entries: merged, labels };
}
