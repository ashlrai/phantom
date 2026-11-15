/**
 * routes/verse/shell/last-seen-store.ts — when the operator last had the Leader
 * or the Feed in front of them, for the unread chips.
 *
 * One localStorage key holds both times. Reads are defensive: a missing,
 * corrupt or unreadable value reads as "now" (pinned for the session), so a
 * fresh profile shows 0 rather than every old item. Same module-level value +
 * listener set shape as home-view-store.ts.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { PRODUCT_NAME } from '../../../app/product-brand.js';
import { useDocumentVisible } from './section-visibility.js';
import type { SeenTimes } from './unread-counts.js';

export const LAST_SEEN_STORAGE_KEY = 'ashlr.verse.last-seen.v1';

export type SeenView = keyof SeenTimes;

let cache: SeenTimes | undefined;
const listeners = new Set<() => void>();

const validTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function load(): SeenTimes {
  const now = Date.now();
  try {
    const raw = localStorage.getItem(LAST_SEEN_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      const rec = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
      return { leader: validTime(rec.leader) ? rec.leader : now, feed: validTime(rec.feed) ? rec.feed : now };
    }
  } catch { /* corrupt or unreadable: treat as now */ }
  return { leader: now, feed: now };
}

export function readLastSeen(): SeenTimes {
  return cache ??= load();
}

/** Stamp one view as seen at `at` (never backwards); the other view's time is untouched. */
export function markSeen(view: SeenView, at: number = Date.now()): void {
  const current = readLastSeen();
  if (at <= current[view]) return;
  cache = { ...current, [view]: at };
  try { localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify(cache)); } catch { /* best-effort */ }
  for (const listener of listeners) listener();
}

/** Tests: forget the in-memory value so the next read hits storage again. */
export function resetLastSeen(): void {
  cache = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLastSeen(): SeenTimes {
  return useSyncExternalStore(subscribe, readLastSeen, readLastSeen);
}

/**
 * Keep `view` marked seen while it is the visible home view and the document is
 * visible; `latest` (newest item time, ms) lets a line that arrives while
 * watching count as seen too.
 */
export function useMarkSeenWhileViewing(view: SeenView | null, latest: number): void {
  const docVisible = useDocumentVisible();
  useEffect(() => {
    if (view !== null && docVisible) markSeen(view, Math.max(Date.now(), latest));
  }, [view, docVisible, latest]);
}

/** "(N) Phantom" while `total` > 0; the title that was there comes back at 0 (or on unmount). */
export function useUnreadTitle(total: number): void {
  useEffect(() => {
    if (total <= 0) return;
    const original = document.title;
    const marked = `(${total}) ${PRODUCT_NAME}`;
    document.title = marked;
    return () => { if (document.title === marked) document.title = original; };
  }, [total]);
}
