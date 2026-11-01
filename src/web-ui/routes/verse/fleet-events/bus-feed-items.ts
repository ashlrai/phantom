import { narrowBusFeedPage } from './agent-bus-feed-query.js';
import { sortNewestFirst, type FeedItem } from './fleet-events-model.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const iso = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

export function busFeedItems(page: unknown): FeedItem[] {
  const data = narrowBusFeedPage(page);
  if (!data) return [];
  return data.messages.map(({ envelope }) => {
    const body = record(envelope.body);
    const excerpt = typeof body.text === 'string' ? body.text : typeof body.kind === 'string' ? body.kind
      : (JSON.stringify(envelope.body) ?? '').slice(0, 120);
    // Prefer the interjection's event time, then an optional page timestamp. The
    // receipt time is transport metadata, not the time the agent said it.
    const at = iso(body.receivedAt) ? body.receivedAt : iso(data.timestamp) ? data.timestamp : '';
    return { id: `bus:${envelope.id}`, kind: 'bus', at,
      text: `${envelope.from} -> ${envelope.to} [${envelope.priority}] ${excerpt}`, url: null };
  });
}

export function mergeFeeds(a: readonly FeedItem[], b: readonly FeedItem[]): FeedItem[] {
  return sortNewestFirst([...a, ...b]);
}
