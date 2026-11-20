/**
 * routes/verse/session-wall/wall-seen.ts: how many messages each conversation
 * held when Mason last had it open, or when the Conversations pane first saw
 * it. The difference from the newest read is the "N new" mark on a card and
 * on a row of the list beside an open conversation.
 *
 * Kept in memory for this window only, so the mark means "since you last
 * looked here, in this sitting". The count is the read's own `messageCount`;
 * the read keeps only the newest part of a long conversation, so a session
 * whose total has stopped growing shows no mark even while its lines change.
 */
interface Counted { session: { id: string }; messageCount: number }

const seen = new Map<string, number>();

/** Records a first sight of each session, and everything in the open conversation as read. Sessions that left the read are forgotten. */
export function noteWallSeen(entries: readonly Counted[], openId: string | null): void {
  const present = new Set<string>();
  for (const { session: { id }, messageCount } of entries) {
    present.add(id);
    const before = seen.get(id);
    // A total that shrank (old lines dropped off the read) becomes the new mark, so later growth still counts.
    if (before === undefined || id === openId || messageCount < before) seen.set(id, messageCount);
  }
  for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
}

/** Messages added since the session was last looked at. Zero for the open conversation and for one never seen before. */
export function unseenCount(entry: Counted, openId: string | null): number {
  const before = seen.get(entry.session.id);
  if (before === undefined || entry.session.id === openId) return 0;
  return Math.max(0, entry.messageCount - before);
}

export function forgetWallSeen(): void {
  seen.clear();
}
