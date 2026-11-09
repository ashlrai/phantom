/**
 * routes/verse/shell/unread-counts.ts — how many Leader lines and Feed items
 * are newer than the operator last looked, for the compact strip's chips and
 * the window title. Pure; types only.
 */
import type { MergedLine } from '../leader-thread/thread-merge-model.js';
import type { FeedItem } from '../feed/feed-model.js';

export interface UnreadCounts { leader: number; feed: number }
export type SeenTimes = Record<keyof UnreadCounts, number>;

/** Beyond this the chip reads "99+". */
export const UNREAD_DISPLAY_CAP = 99;

export function unreadCounts({ leaderLines, feedItems, seen }: {
  leaderLines: readonly Pick<MergedLine, 'at' | 'who' | 'source'>[];
  feedItems: readonly Pick<FeedItem, 'at'>[];
  seen: SeenTimes;
}): UnreadCounts {
  // Mason's own words and system notes are not news; a line at the seen instant was already seen.
  const leader = leaderLines.filter(l => l.who === 'leader' && l.source !== 'system' && l.at > seen.leader).length;
  const feed = feedItems.filter(i => Date.parse(i.at) > seen.feed).length;
  return { leader, feed };
}

/** The chip text: the number, or "99+". */
export const unreadLabel = (count: number): string => count > UNREAD_DISPLAY_CAP ? `${UNREAD_DISPLAY_CAP}+` : String(count);
