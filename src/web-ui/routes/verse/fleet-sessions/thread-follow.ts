/**
 * Following an open session conversation while it grows. The read is polled,
 * so messages arrive under the reader: while the end of the conversation is on
 * screen the view follows them; once the reader has scrolled up it stays put,
 * a "New" mark sits above the first message they have not reached and a count
 * says how many wait. Reaching the end clears the count and leaves the mark
 * where it was, so the place is not lost. Nothing here is a fleet fact: "new"
 * means "arrived since the end was last on screen". A conversation that was
 * read to its end before (thread-read-store.ts) opens with the mark above the
 * first message that arrived since.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { dayLabel } from '../leader/thread-model.js';

export interface FollowState {
  /** The session this state belongs to; another session starts over. */
  id: string;
  /** Message keys of the newest read, in display order. */
  keys: readonly string[];
  /** Keys the reader has had on screen (or that were there when the conversation opened). */
  seen: ReadonlySet<string>;
  /** The message the "New" mark sits above; null when there is none. */
  markKey: string | null;
  /** Counts arrivals that came in while the end was on screen, so the view can follow each one. */
  followed: number;
}

/**
 * The first read. Everything counts as read except the keys in `unread` (what arrived since the conversation was last read to
 * its end); the mark sits above the first of those. With none, opening a conversation never marks its history as new.
 */
export function startFollow(id: string, keys: readonly string[], unread: readonly string[] = []): FollowState {
  const waiting = new Set(unread);
  const markKey = keys.find(key => waiting.has(key)) ?? null;
  return { id, keys, seen: new Set(markKey === null ? keys : keys.filter(key => !waiting.has(key))), markKey, followed: 0 };
}

export const unseenKeys = (state: FollowState): string[] => state.keys.filter(key => !state.seen.has(key));

/** A later read. `pinned` is whether the end of the conversation was on screen when it arrived. */
export function arrive(state: FollowState, keys: readonly string[], pinned: boolean): FollowState {
  const fresh = keys.filter(key => !state.seen.has(key));
  if (fresh.length === 0) return { ...state, keys, markKey: state.markKey !== null && keys.includes(state.markKey) ? state.markKey : null };
  // Read on arrival: the reader is watching the end, so there is no place to keep.
  if (pinned) return { ...state, keys, seen: new Set([...state.seen, ...fresh]), markKey: null, followed: state.followed + 1 };
  // The mark stays on the message it was put above while that one is still unread; otherwise it moves to the first unread.
  const markKey = state.markKey !== null && fresh.includes(state.markKey) ? state.markKey : fresh[0]!;
  return { ...state, keys, markKey };
}

/** The end came on screen: every message counts as read. The mark stays until the next arrival moves or removes it. */
export function reachEnd(state: FollowState): FollowState {
  return state.keys.every(key => state.seen.has(key)) ? state : { ...state, seen: new Set([...state.seen, ...state.keys]) };
}

/** "3 new messages"; the count is of messages that arrived, never a guess at how many matter. */
export const newCountLabel = (count: number): string => `${count} new ${count === 1 ? 'message' : 'messages'}`;

const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/**
 * A day heading for the first dated message of each local day, only when the conversation spans more than one
 * day (a conversation of one day needs none: every message already shows its clock time). Undated messages
 * (the brief, the command list) never start a day.
 */
export function dayBreaks(messages: readonly { key: string; at: string | null }[], now: number = Date.now()): Map<string, string> {
  const breaks = new Map<string, string>();
  let day: string | null = null;
  for (const message of messages) {
    const ms = message.at === null ? Number.NaN : Date.parse(message.at);
    if (!Number.isFinite(ms)) continue;
    const next = localDay(ms);
    if (next !== day) { breaks.set(message.key, dayLabel(message.at!, now)); day = next; }
  }
  return breaks.size > 1 ? breaks : new Map();
}

export interface ThreadFollow {
  /** The message the "New" mark sits above. */
  markKey: string | null;
  /** How many messages arrived that the reader has not reached. */
  unseen: number;
  /** Scrolls to the "New" mark (the first unread message), or to the end when there is no mark. */
  jumpToNew: () => void;
  /** Scrolls to the newest message. */
  jumpToEnd: () => void;
  /** Every message of the newest read has been on screen. False until the first read has been taken in. */
  caughtUp: boolean;
}

const NOTHING_UNREAD: readonly string[] = [];

export const NEW_MARK_ATTR = 'data-new-mark';

/**
 * `keys` is null until the conversation has been read. `end` is the element after the conversation; whether it is on
 * screen decides between following and keeping the reader's place. Without IntersectionObserver the view follows.
 * `unreadAtOpen` (message keys) is used once, when the conversation's first read arrives. While `hold` is true the reader is
 * being kept at a line of their choosing (ThreadFound.tsx), and an arrival does not scroll the view to the end.
 */
export function useThreadFollow(id: string, keys: readonly string[] | null, root: RefObject<HTMLElement | null>, end: RefObject<HTMLElement | null>,
  unreadAtOpen: readonly string[] = NOTHING_UNREAD, hold?: RefObject<boolean>): ThreadFollow {
  const [state, setState] = useState<FollowState | null>(null);
  const pinned = useRef(true);
  const signature = keys === null ? null : keys.join('\n');
  useEffect(() => {
    if (keys === null) return;
    setState(prev => (prev === null || prev.id !== id ? startFollow(id, keys, unreadAtOpen) : arrive(prev, keys, pinned.current)));
    // `signature` stands for `keys`: the array is rebuilt by every poll, its content is what matters. `unreadAtOpen` is read only on the first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, signature]);

  const loaded = keys !== null;
  useEffect(() => {
    const node = end.current;
    pinned.current = true;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1];
      if (!last) return;
      pinned.current = last.isIntersecting;
      if (last.isIntersecting) setState(prev => (prev === null ? prev : reachEnd(prev)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [end, id, loaded]);

  const current = state !== null && state.id === id ? state : null;
  const followed = current?.followed ?? 0;
  // Follow an arrival the reader was watching the end for; the first read is placed by the conversation itself.
  useLayoutEffect(() => { if (followed > 0 && !hold?.current) end.current?.scrollIntoView?.({ block: 'nearest' }); }, [end, followed, hold]);

  const jumpToEnd = useCallback(() => { end.current?.scrollIntoView?.({ block: 'nearest' }); }, [end]);
  const jumpToNew = useCallback(() => {
    const mark = root.current?.querySelector(`[${NEW_MARK_ATTR}]`);
    if (mark) mark.scrollIntoView?.({ block: 'start' });
    else jumpToEnd();
  }, [root, jumpToEnd]);
  // Asked of the keys in hand, not the ones last taken in: a read that has just arrived is not caught up with until it has been.
  const caughtUp = current !== null && keys !== null && keys.every(key => current.seen.has(key));
  return { markKey: current?.markKey ?? null, unseen: current === null ? 0 : unseenKeys(current).length, jumpToNew, jumpToEnd, caughtUp };
}
