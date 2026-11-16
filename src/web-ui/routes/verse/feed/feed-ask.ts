/**
 * routes/verse/feed/feed-ask.ts: the composer draft for "Ask Leader" on a Feed
 * item. Pure; every field is untrusted (model output, PR titles), so the quote
 * is one line of plain text and only an https href is referenced.
 */
import type { FeedItem, FeedKind } from './feed-model.js';

export const ASK_TITLE_MAX = 160;
const KIND_LABEL: Record<FeedKind, string> = { leader: 'Leader', alert: 'Alert', merge: 'Merge', fleet: 'Fleet', owner: 'Channel', update: 'Update', bus: 'Bus', teammate: 'Dot', comms: 'Comms' };

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `About: <kind> "<title>" (<https href>)` and a blank line, ready for Mason to type under. */
export function askLeaderDraft(item: FeedItem): string {
  const title = oneLine(item.title);
  const quoted = title.length > ASK_TITLE_MAX ? `${title.slice(0, ASK_TITLE_MAX - 1)}…` : title;
  const href = item.href?.startsWith('https://') ? oneLine(item.href) : '';
  return `About: ${KIND_LABEL[item.kind]} "${quoted}"${href ? ` (${href})` : ''}\n\n`;
}
