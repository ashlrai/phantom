/**
 * routes/verse/feed/feed-dismiss-store.ts: which Feed items the operator has
 * cleared, remembered across reloads and restarts.
 *
 * A map of item id → fingerprint under one versioned localStorage key. A
 * normal item's fingerprint is its id, so it stays cleared for good. An urgent
 * item (an alert or a P0/P1 bus message) adds its time and a hash of its text,
 * so it comes back if it changes: nothing important is hidden forever.
 *
 * Same shape as shell/home-view-store.ts: a module-level value and listener
 * set, best-effort storage (Safari private mode throws; corrupt JSON is empty).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { FeedItem } from './feed-model.js';

export const FEED_DISMISS_STORAGE_KEY = 'ashlr.verse.feed.dismissed.v1';
export const FEED_DISMISS_CAP = 500;

export type DismissedMap = Readonly<Record<string, string>>;

const isUrgent = (item: FeedItem): boolean => item.kind === 'alert' || item.kind === 'bus';

/** FNV-1a: a short, stable stand-in for the text; no crypto needed. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function fingerprintOf(item: FeedItem): string {
  return isUrgent(item) ? `${item.id}|${item.at}|${hash(`${item.title}\n${item.body ?? ''}`)}` : item.id;
}

export const isDismissed = (item: FeedItem, map: DismissedMap): boolean => map[item.id] === fingerprintOf(item);

/** Dismiss one item; the oldest entries fall off past FEED_DISMISS_CAP. */
export function dismiss(map: DismissedMap, item: FeedItem): DismissedMap {
  const { [item.id]: _old, ...rest } = map;
  const entries = Object.entries({ ...rest, [item.id]: fingerprintOf(item) });
  return Object.fromEntries(entries.slice(-FEED_DISMISS_CAP));
}

export function restore(map: DismissedMap, item: FeedItem): DismissedMap {
  const { [item.id]: _old, ...rest } = map;
  return rest;
}

/** Parse stored JSON into a map; anything that is not a string-to-string object is empty. */
function parse(raw: string | null): DismissedMap {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string').slice(-FEED_DISMISS_CAP));
  } catch {
    return {};
  }
}

const NONE: DismissedMap = {};
let current: DismissedMap | undefined;
const listeners = new Set<() => void>();

export function readStored(): DismissedMap {
  if (current !== undefined) return current;
  try {
    current = parse(localStorage.getItem(FEED_DISMISS_STORAGE_KEY));
  } catch {
    current = {};
  }
  return current;
}

export function writeStored(next: DismissedMap): void {
  current = next;
  try {
    localStorage.setItem(FEED_DISMISS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort: it still holds for this session */
  }
  for (const listener of listeners) listener();
}

/** Forget every dismissal, so all items show again. */
export function restoreAll(): void {
  writeStored({});
}

/** Tests: drop the in-memory copy so the next read hits storage again. */
export function resetFeedDismissals(): void {
  current = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== FEED_DISMISS_STORAGE_KEY) return;
    current = undefined;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

/** The dismissed map (re-read when another window changes it) and the actions on it. */
export function useFeedDismissals() {
  const map = useSyncExternalStore(subscribe, readStored, () => NONE);
  const dismissItem = useCallback((item: FeedItem) => writeStored(dismiss(readStored(), item)), []);
  const restoreItem = useCallback((item: FeedItem) => writeStored(restore(readStored(), item)), []);
  return useMemo(() => ({ map, dismissItem, restoreItem, restoreAll }), [map, dismissItem, restoreItem]);
}

