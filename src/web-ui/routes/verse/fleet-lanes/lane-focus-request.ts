import { useSyncExternalStore } from 'react';

const LANE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

let pendingLane: string | null = null;
const listeners = new Set<() => void>();

function setPendingLane(lane: string | null): void {
  if (pendingLane === lane) return;
  pendingLane = lane;
  for (const listener of [...listeners]) listener();
}

export function requestLaneFocus(lane: string): void {
  if (LANE_RE.test(lane)) setPendingLane(lane);
}

export function takeRequestedLane(): string | null {
  const lane = pendingLane;
  setPendingLane(null);
  return lane;
}

export function subscribeLaneFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = (): string | null => pendingLane;

export function useRequestedLane(): string | null {
  return useSyncExternalStore(subscribeLaneFocus, getSnapshot, getSnapshot);
}

export function resetLaneFocus(): void {
  setPendingLane(null);
}
