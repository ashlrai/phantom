/**
 * routes/verse/leader-thread/surface-layout.ts: how the Leader pane lays out a
 * session opened from "Working now". With room, the session's conversation
 * sits beside the Leader chat, so both reply boxes are on screen; without it,
 * the conversation covers the chat as before. Also the pure half of stepping
 * from one working session's conversation to the next.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';
import { flatTree, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';

/** The narrowest pane that holds the Leader chat and a session side by side. */
export const BESIDE_MIN_PX = 900;

export function fitsBeside(width: number): boolean {
  return width >= BESIDE_MIN_PX;
}

export const SPLIT_DEFAULT = 44, SPLIT_MIN = 28, SPLIT_MAX = 64;
export const SPLIT_STEP = 2, SPLIT_STEP_COARSE = 8;
export const READING_MIN_PX = 340, CHAT_MIN_PX = 420;

/** Keep both conversations readable as well as respecting the percentage limits. */
export function clampSplit(split: number, width: number): number {
  const low = width > 0 ? Math.max(SPLIT_MIN, Math.ceil(READING_MIN_PX / width * 100)) : SPLIT_MIN;
  const high = width > 0 ? Math.min(SPLIT_MAX, Math.floor((1 - CHAT_MIN_PX / width) * 100)) : SPLIT_MAX;
  return !Number.isFinite(split) || low > high ? SPLIT_DEFAULT : Math.min(high, Math.max(low, Math.round(split)));
}

export function holdsSession(list: LiveSessionsV1, id: string): boolean {
  return flatTree(list.tree.roots).some(({ node }) => node.id === id && node.kind !== 'unknown-parent');
}

/**
 * True while `ref` is wide enough for two conversations. A width of 0 means
 * "not laid out" (a hidden tab, jsdom): that keeps the last answer, which
 * starts as false, so an unmeasured pane never squeezes two columns.
 */
export function useSurfaceFit(ref: RefObject<HTMLElement | null>): { beside: boolean; measured: boolean } {
  const [fit, setFit] = useState({ beside: false, measured: false });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const read = (): void => {
      const width = node.getBoundingClientRect().width;
      if (width <= 0) return;
      const beside = fitsBeside(width);
      setFit(was => was.measured && was.beside === beside ? was : { beside, measured: true });
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return fit;
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
