/**
 * routes/verse/fleet-sessions/thread-depth.ts: which session conversations
 * Mason asked to see with their earlier entries. The session-thread read
 * shows the newest few of each record unless it is asked for `depth=full`
 * (core/fleet/session-thread.ts, `phm sessions thread <id> --all`); a
 * conversation named here is read at that depth by every caller of
 * `sessionThreadQuery`, polls included, so it stays whole while it is followed.
 *
 * Kept for this window only: a reload starts every conversation at the newest
 * entries again. Nothing here is a fleet fact.
 */
import { useSyncExternalStore } from 'react';

const asked = new Set<string>();
const listeners = new Set<() => void>();

export const wantsEarlier = (id: string): boolean => asked.has(id);

/** Asks for (or gives up) the earlier entries of one conversation. The caller reads the conversation again. */
export function setWantsEarlier(id: string, on: boolean): void {
  if (asked.has(id) === on) return;
  if (on) asked.add(id); else asked.delete(id);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useWantsEarlier(id: string): boolean {
  return useSyncExternalStore(subscribe, () => asked.has(id), () => false);
}

/** Every conversation back to its newest entries (tests, and nothing else). */
export function forgetEarlier(): void {
  asked.clear();
  for (const listener of [...listeners]) listener();
}
