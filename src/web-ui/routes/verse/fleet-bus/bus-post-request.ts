import { useSyncExternalStore } from 'react';

type BusPostRequest = { to: string; quote: string; text: string };
type JobDetail = { state: string; publish?: { prUrl?: string | null } | null } | null | undefined;

let pending: BusPostRequest | null = null;
const listeners = new Set<() => void>();

function setPending(request: BusPostRequest | null): void {
  pending = request;
  for (const listener of [...listeners]) listener();
}

export function requestBusPost(request: BusPostRequest): void { setPending(request); }
export function takeBusPostRequest(): BusPostRequest | null {
  const request = pending;
  if (request) setPending(null);
  return request;
}
export function subscribeBusPostRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const getSnapshot = () => pending;
export function useBusPostRequest(): BusPostRequest | null {
  return useSyncExternalStore(subscribeBusPostRequest, getSnapshot, getSnapshot);
}
export function busTellPrefill(job: string, detail: JobDetail): BusPostRequest {
  return { to: job, quote: `${job} · ${detail?.state ?? 'unknown'} · ${detail?.publish?.prUrl || 'no PR yet'}`, text: '' };
}
