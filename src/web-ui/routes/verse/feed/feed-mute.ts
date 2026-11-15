import type { FeedItem } from './feed-model.js';

/** Alerts and items needing the owner remain visible regardless of preferences. */
export function isFeedItemVisible(item: FeedItem & { severity?: string; needsYou?: boolean }, muted: readonly string[]): boolean {
  return item.kind === 'alert' || item.kind === 'bus' || item.severity === 'alert' || item.severity === 'error' || item.needsYou === true || !muted.includes(item.kind);
}
