/**
 * routes/verse/leader-thread/surface-layout.ts: how the Leader pane lays out a
 * session opened from "Working now". With room, the session's conversation
 * sits beside the Leader chat, so both reply boxes are on screen; without it,
 * the conversation covers the chat as before. Also the pure half of stepping
 * from one working session's conversation to the next.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';

/** The narrowest pane that holds the Leader chat and a session side by side. */
export const BESIDE_MIN_PX = 900;

export function fitsBeside(width: number): boolean {
  return width >= BESIDE_MIN_PX;
}

/**
 * True while `ref` is wide enough for two conversations. A width of 0 means
 * "not laid out" (a hidden tab, jsdom): that keeps the last answer, which
 * starts as false, so an unmeasured pane never squeezes two columns.
 */
export function useBeside(ref: RefObject<HTMLElement | null>): boolean {
  const [beside, setBeside] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const read = (): void => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setBeside(fitsBeside(width));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return beside;
}

/**
 * The working session after (delta 1) or before (delta -1) `current`, going
 * round. From a session that has left the list, forward lands on the first
 * and back on the last. Null when there is nowhere else to go.
 */
export function threadStep(working: readonly string[], current: string, delta: 1 | -1): string | null {
  if (working.length === 0) return null;
  const at = working.indexOf(current);
  if (at < 0) return delta === 1 ? working[0]! : working[working.length - 1]!;
  const next = working[(at + delta + working.length) % working.length]!;
  return next === current ? null : next;
}

/** Where the open conversation stands among the working sessions, in words; null list means the read has not answered. */
export function stepWords(working: readonly string[] | null, current: string): string {
  if (working === null) return 'Working sessions unknown';
  const at = working.indexOf(current);
  if (at >= 0) return `${at + 1} of ${working.length} working`;
  return working.length === 0 ? 'Not working now · nobody else is' : `Not working now · ${working.length} working`;
}
