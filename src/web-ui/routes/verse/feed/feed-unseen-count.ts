import { isDismissed, type DismissedMap } from './feed-dismiss-store.js';
import type { FeedItem } from './feed-model.js';
import { countNew } from './feed-seen-store.js';

/** Use the Feed's ordering, seen timestamp and dismissal fingerprints. */
export function unseenCount(items: readonly FeedItem[], seen: string | null, dismissed: DismissedMap): number {
  return countNew(items.filter(item => !isDismissed(item, dismissed)), seen);
}
