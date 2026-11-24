import { AsyncLocalStorage } from 'node:async_hooks';
import type { Backlog, ScannerObservation, WorkItem } from '../types.js';

export interface BacklogScanSnapshot {
  remote: Map<string, Promise<string | null>>;
  results: Map<string, Promise<{ items: WorkItem[]; observations: ScannerObservation[]; skipped?: NonNullable<Backlog['skippedScanners']>[number] }>>;
}

export function createBacklogScanSnapshot(): BacklogScanSnapshot {
  return { remote: new Map(), results: new Map() };
}

export const backlogScanContext = new AsyncLocalStorage<{
  snapshot?: BacklogScanSnapshot;
  signal: AbortSignal;
}>();
