import { useSyncExternalStore } from 'react';
import { JOB_ID_RE } from './worker-log-model.js';

let pendingJob: string | null = null;
const listeners = new Set<() => void>();

function setPendingJob(job: string | null): void {
  if (pendingJob === job) return;
  pendingJob = job;
  for (const listener of [...listeners]) listener();
}

export function requestWorkerLogJob(job: string): void {
  if (JOB_ID_RE.test(job)) setPendingJob(job);
}

export function takeRequestedWorkerLogJob(): string | null {
  const job = pendingJob;
  setPendingJob(null);
  return job;
}

export function subscribeWorkerLogSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = (): string | null => pendingJob;

export function useRequestedWorkerLogJob(): string | null {
  return useSyncExternalStore(subscribeWorkerLogSelection, getSnapshot, getSnapshot);
}

export function resetWorkerLogSelection(): void {
  setPendingJob(null);
}
