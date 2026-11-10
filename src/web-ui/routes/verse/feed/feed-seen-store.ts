/**
 * routes/verse/feed/feed-seen-store.ts: when the operator last looked at the
 * Feed, so the Feed can say what arrived since.
 *
 * One ISO time under a versioned localStorage key. Same shape as
 * feed-dismiss-store.ts: a module-level value and listener set, best-effort
 * storage (Safari private mode throws; corrupt JSON reads as unset) and a
 * cross-window `storage` event. An unset time means nothing is new, so a first
 * launch never shows the whole history as new; the hook stamps "now" then.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { FeedItem } from './feed-model.js';

export const FEED_SEEN_STORAGE_KEY = 'ashlr.verse.feed.seen.v1';

type Timed = Pick<FeedItem, 'at'>;

/** Epoch ms of an ISO time, or null when absent or unparseable. */
function millis(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** How many items (newest first) arrived after `seenAt`. Unset or unparseable: 0. */
export function countNew(items: readonly Timed[], seenAt: string | null): number {
  const seen = millis(seenAt);
  if (seen === null) return 0;
  const first = items.findIndex(item => !((millis(item.at) ?? -Infinity) > seen));
  return first === -1 ? items.length : first;
}

/** Index of the first item that is not new, or -1 when every item is new. Unset seenAt: 0. */
export function firstOlderIndex(items: readonly Timed[], seenAt: string | null): number {
  const seen = millis(seenAt);
  if (seen === null) return items.length ? 0 : -1;
  return items.findIndex(item => !((millis(item.at) ?? -Infinity) > seen));
}

function parse(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' && millis(value) !== null ? value : null;
  } catch {
    return null;
  }
}

let current: string | null | undefined;
const listeners = new Set<() => void>();

export function readStored(): string | null {
  if (current !== undefined) return current;
  try {
    current = parse(localStorage.getItem(FEED_SEEN_STORAGE_KEY));
  } catch {
    current = null;
  }
  return current;
}

/** Move the seen time forward; an older or unparseable time is ignored. */
export function markSeen(atIso: string): void {
  const next = millis(atIso);
  if (next === null) return;
  const prev = millis(readStored());
  if (prev !== null && next <= prev) return;
  current = atIso;
  try {
    localStorage.setItem(FEED_SEEN_STORAGE_KEY, JSON.stringify(atIso));
  } catch {
    /* best-effort: it still holds for this session */
  }
  for (const listener of listeners) listener();
}

/** Tests: drop the in-memory copy so the next read hits storage again. */
export function resetFeedSeen(): void {
  current = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== FEED_SEEN_STORAGE_KEY) return;
    current = undefined;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

/** The last-seen time (re-read when another window changes it) and the action that moves it forward. */
export function useFeedSeen() {
  const seenAt = useSyncExternalStore(subscribe, readStored, () => null);
  // First launch: nothing stored yet, so everything on screen counts as seen.
  useEffect(() => { if (readStored() === null) markSeen(new Date().toISOString()); }, [seenAt]);
  const mark = useCallback((atIso: string) => markSeen(atIso), []);
  return useMemo(() => ({ seenAt, markSeen: mark }), [seenAt, mark]);
}
