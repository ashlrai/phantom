/**
 * Earlier messages in the Leader pane, the pure half. The pane reads the newest page of the Leader thread
 * (GET /api/verse/leader/thread?limit=50); the pages before it come from the same route with `before=<oldest id>`.
 * Nothing here invents a message or a count: the totals are the messages actually held on screen.
 */
import { dayLabel } from '../leader/thread-model.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';

export type EarlierState = 'idle' | 'loading' | 'done' | 'error';

/**
 * The parts as one thread, oldest first, each id once. A message keeps the place of its first sighting and the
 * content of its newest one, so a question answered since it was first read shows as answered.
 */
export function joinThread(...parts: readonly (readonly LeaderThreadMessage[])[]): LeaderThreadMessage[] {
  const byId = new Map<string, LeaderThreadMessage>();
  for (const part of parts) for (const message of part) byId.set(message.id, message);
  return [...byId.values()];
}

/**
 * Whether there may be a page before the oldest message held. A newest page shorter than the page size is the
 * whole thread; a short earlier page (state `done`) is its start.
 */
export function canLoadEarlier(state: EarlierState, pageLength: number, earlierCount: number, pageSize: number): boolean {
  return state !== 'loading' && state !== 'done' && (earlierCount > 0 || pageLength >= pageSize);
}

/** Whether the row above the conversation has anything to say. */
export function earlierShown(state: EarlierState, pageLength: number, earlierCount: number, pageSize: number): boolean {
  return state !== 'idle' || earlierCount > 0 || pageLength >= pageSize;
}

const count = (total: number) => `${total} thread ${total === 1 ? 'message' : 'messages'}`;

/** The row's sentence. `oldestAt` is the time of the oldest message held, `reason` the failed read's own words. */
export function earlierLine(view: { state: EarlierState; total: number; earlierCount: number; oldestAt: string | null; reason: string | null }, now: number): string {
  const { state, total, earlierCount, oldestAt, reason } = view;
  if (state === 'loading') return 'Loading earlier messages…';
  if (state === 'error') return `Earlier messages did not load. ${reason ?? 'The request failed.'}`;
  if (state === 'done') return earlierCount === 0 ? 'No earlier messages are held here.' : `Start of the conversation held here · ${count(total)}`;
  if (earlierCount === 0) return `Newest ${count(total)} shown`;
  const back = oldestAt !== null && Number.isFinite(Date.parse(oldestAt)) ? dayLabel(oldestAt, now) : 'a time unknown';
  return `${count(total)}, back to ${back}`;
}

/** The keys that ask for more when the conversation is already scrolled to its top. */
export function asksForEarlier(key: string): boolean {
  return key === 'ArrowUp' || key === 'PageUp' || key === 'Home';
}
