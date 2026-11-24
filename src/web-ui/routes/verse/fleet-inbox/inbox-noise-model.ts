import { isFlagOnlyText, isStatusAskText } from '../leader-thread/thread-noise-model.js';

export type InboxEntryKind = 'order' | 'status-ask' | 'misfire';

/** Classify an inbox entry for display only; the underlying inbox data is never changed. */
export function inboxEntryKind(entry: { text: string }): InboxEntryKind {
  if (isFlagOnlyText(entry.text)) return 'misfire';
  return isStatusAskText(entry.text) ? 'status-ask' : 'order';
}

/** Split entries into real orders and noise (status asks and CLI misfires), keeping input order in both. */
export function partitionInboxNoise<T extends { text: string }>(entries: readonly T[]): { orders: T[]; noise: T[] } {
  const orders: T[] = [], noise: T[] = [];
  for (const entry of entries) (inboxEntryKind(entry) === 'order' ? orders : noise).push(entry);
  return { orders, noise };
}
