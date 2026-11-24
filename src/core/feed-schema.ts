/**
 * core/feed-schema.ts — the Feed's wire shapes (`phm feed --json`, GET /api/feed).
 * Pure types and constants, so the desktop can import them without Node modules.
 */
/** Bump `version` (and the schema name) on any breaking change to these shapes. */
export const FEED_SCHEMA = 'phantom.feed.v2';
export const FEED_VERSION = 2;
/** `failed` is main going red or a job ending failed or empty; `lane` is a lane pausing (plan limit, hold) or running again; `incident` is a dispatch incident, stopped or parked job. */
export const FEED_KINDS = ['merged', 'released', 'failed', 'lane', 'incident', 'leader'] as const;
export type FeedKind = typeof FEED_KINDS[number];
export const FEED_SOURCES = ['jobs', 'events', 'leader', 'merges', 'releases', 'main'] as const;
export type FeedSourceName = typeof FEED_SOURCES[number];
export type FeedSourceState = 'available' | 'unknown';

/** One event inside a burst. */
export interface FeedGroupEntry { text: string; href: string; at: string }
/**
 * One event: `text` is its plain-words title and `href` its one link. `detail` is the recorded
 * wording behind a rewritten title; `lane`, `repo` and `job` are null when not recorded.
 * `count` is how many identical consecutive events it stands for (always >= 1).
 * `group` is present only on a burst (several merges in one repo in one clock hour) and lists them newest first.
 */
export interface FeedItem {
  id: string; kind: FeedKind; at: string; text: string; detail: string | null; href: string;
  repo: string | null; lane: string | null; job: string | null; count: number; group?: FeedGroupEntry[];
}
export interface FeedReport {
  schema: typeof FEED_SCHEMA; version: typeof FEED_VERSION;
  items: FeedItem[];
  /** True when older items matched the query beyond `limit`; ask again with a larger limit. */
  more: boolean;
  /** The cursor: pass it back as `since` to read only newer events. Null when there is nothing to resume from. */
  next: string | null;
  sources: Record<FeedSourceName, FeedSourceState>;
}
export interface FeedQuery { limit: number; sinceMs?: number; kind?: FeedKind }

export const FEED_MAX_LIMIT = 1000;
/** This many merges in one repo in one clock hour read as one card. */
export const FEED_BURST_MIN = 3;
