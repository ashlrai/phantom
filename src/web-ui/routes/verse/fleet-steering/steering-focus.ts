import { useSyncExternalStore } from 'react';
import { naiveClock, type SteeringEntry } from './steering-model.js';

export type SteeringFocusRequest = { at: string; label: string };

let pending: SteeringFocusRequest | null = null;
const listeners = new Set<() => void>();

function setPending(request: SteeringFocusRequest | null): void {
  pending = request;
  for (const listener of [...listeners]) listener();
}

export function requestSteeringFocus(request: SteeringFocusRequest): void {
  setPending({ ...request });
}

export function takeSteeringFocus(): SteeringFocusRequest | null {
  const request = pending;
  if (request) setPending(null);
  return request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = () => pending;
export function useSteeringFocus(): SteeringFocusRequest | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function matchSteeringEntry(entries: readonly SteeringEntry[], request: SteeringFocusRequest): number | null {
  const exact = entries.findIndex((entry) => entry.at === request.at);
  if (exact !== -1) return exact;
  const label = request.label.trim().replace(/\s+/g, ' ').toLowerCase();
  const clock = naiveClock(request.at);
  if (!label || clock === null) return null;
  const index = entries.findIndex((entry) => {
    const at = naiveClock(entry.at);
    return at !== null && Math.abs(at - clock) <= 5
      && entry.text.trim().replace(/\s+/g, ' ').toLowerCase().startsWith(label);
  });
  return index === -1 ? null : index;
}
