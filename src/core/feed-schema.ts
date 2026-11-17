/**
 * core/feed-schema.ts — the Feed's wire shapes (`phm feed --json`, GET /api/feed).
 * Pure types and constants, so the desktop can import them without Node modules.
 */
/** Bump `version` (and the schema name) on any breaking change to these shapes. */
export const FEED_SCHEMA = 'phantom.feed.v2';
export const FEED_VERSION = 2;
/** `failed` is main going red or a job ending failed or empty; `incident` is a dispatch incident, lane hold or parked job. */
export const FEED_KINDS = ['merged', 'released', 'failed', 'incident', 'leader'] as const;
export type FeedKind = typeof FEED_KINDS[number];
export const FEED_SOURCES = ['jobs', 'events', 'leader', 'merges', 'releases', 'main'] as const;
export type FeedSourceName = typeof FEED_SOURCES[number];
export type FeedSourceState = 'available' | 'unknown';

/** One event. `count` is how many identical consecutive events it stands for (always >= 1). */
export interface FeedItem {
  id: string; kind: FeedKind; at: string; text: string; href: string;
  repo: string | null; job: string | null; count: number;
}
export interface FeedReport {
  schema: typeof FEED_SCHEMA; version: typeof FEED_VERSION;
  items: FeedItem[];
  /** True when older items matched the query beyond `limit`; ask again with a larger limit. */
  more: boolean;
  sources: Record<FeedSourceName, FeedSourceState>;
}
export interface FeedQuery { limit: number; sinceMs?: number; kind?: FeedKind }

export const FEED_MAX_LIMIT = 1000;
