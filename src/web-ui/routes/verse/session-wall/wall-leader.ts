/**
 * routes/verse/session-wall/wall-leader.ts: the Leader's conversation beside
 * the Conversations wall. With room, the pane keeps the Leader's conversation
 * and its reply box on the right of the cards, so reading every session and
 * writing to the Leader happen on one screen. This file holds the parts that
 * are not drawing: which session is the Leader, how much room the pane has,
 * and whether Mason hid the conversation (kept in this browser, a single
 * word, so a reload shows the pane the way it was left).
 */
import { useLayoutEffect, useState } from 'react';

/** The id the session tree gives the Leader (core/fleet/session-tree.ts). Used when the read on screen lists no leader, as a narrowed read never does. */
export const LEADER_SESSION_ID = 'leader';

/** The Leader's session in a read, or the tree's own id for it when the read holds none. */
export function leaderIdOf(entries: readonly { session: { id: string; kind: string } }[] | null | undefined): string {
  return entries?.find(entry => entry.session.kind === 'leader')?.session.id ?? LEADER_SESSION_ID;
}

/** The narrowest pane that holds a readable column of cards and the Leader's conversation side by side. */
export const WALL_LEADER_MIN_PX = 1000;
/** The narrowest pane that holds the session list, an open conversation and the Leader's conversation: three columns. */
export const OPEN_LEADER_MIN_PX = 1360;

/** 0: no room for the Leader beside anything. 1: beside the cards. 2: beside an open conversation as well. */
export type LeaderRoom = 0 | 1 | 2;

export function leaderRoom(width: number): LeaderRoom {
  return width >= OPEN_LEADER_MIN_PX ? 2 : width >= WALL_LEADER_MIN_PX ? 1 : 0;
}

/**
 * The room `node` has, followed as it is resized. A width of 0 means "not
 * laid out" (a hidden tab, jsdom): that keeps the last answer, which starts
 * as no room, so an unmeasured pane never squeezes two columns.
 */
export function useLeaderRoom(node: HTMLElement | null): LeaderRoom {
  const [room, setRoom] = useState<LeaderRoom>(0);
  useLayoutEffect(() => {
    if (!node) return undefined;
    const read = (): void => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setRoom(leaderRoom(width));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return room;
}

export const WALL_LEADER_KEY = 'phantom.sessionWallLeader.v1';
const HIDDEN = 'hidden';

function leaderStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** True when Mason hid the Leader's conversation. Anything else stored, or nothing, or storage denied, reads as shown. */
export function loadLeaderHidden(storage: Storage | null = leaderStorage()): boolean {
  try { return storage?.getItem(WALL_LEADER_KEY) === HIDDEN; } catch { return false; }
}

/** Keeps "hidden" and forgets "shown", the default. False when it could not be written, so the choice lasts only while the pane is open. */
export function saveLeaderHidden(hidden: boolean, storage: Storage | null = leaderStorage()): boolean {
  if (!storage) return false;
  try {
    if (hidden) storage.setItem(WALL_LEADER_KEY, HIDDEN);
    else storage.removeItem(WALL_LEADER_KEY);
    return true;
  } catch {
    return false;
  }
}

export function forgetWallLeader(storage: Storage | null = leaderStorage()): void {
  try { storage?.removeItem(WALL_LEADER_KEY); } catch { /* nothing was kept */ }
}
