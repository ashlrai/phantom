/** Pure shape and wording of Mason's one thread (no I/O, so the web UI can
 * import it). The reader is core/comms/mason-thread.ts. */
import type { WorkItemState } from './work-item-state.js';

export const MASON_THREAD_SCHEMA = 'phantom.mason.thread.v1';
export const MASON_THREAD_EMPTY = 'Nothing yet.';
export type MasonThreadState = WorkItemState | 'UNKNOWN';
export interface MasonThreadItem {
  /** ISO time of the first sighting. */
  at: string;
  dir: 'in' | 'out';
  channel: string;
  text: string;
  /** Reply state for an inbound item; null for the leader's own replies. */
  state: MasonThreadState | null;
  job_ids: string[];
  /** Other channels the same item was seen on (inbound) or sent to (reply). */
  also_on: string[];
}
export interface MasonThread {
  schema: typeof MASON_THREAD_SCHEMA;
  as_of: string;
  since: string;
  items: MasonThreadItem[];
  /** Sources that could not be read, in plain words. Empty when all were. */
  gaps: string[];
}

const WORDS: Record<MasonThreadState, string> = { RECEIVED: 'Received', ASSIGNED: 'Assigned', RUNNING: 'Running', BLOCKED: 'Blocked', VERIFIED: 'Verified', UNKNOWN: 'Unknown' };
export const masonStateWord = (state: MasonThreadState): string => WORDS[state];

/** Plain lines for a terminal: "10:08 Mason via slack (also imessage): text — Running (RQ-1)". */
export function masonThreadText(thread: MasonThread): string {
  if (thread.items.length === 0 && thread.gaps.length === 0) return MASON_THREAD_EMPTY;
  const lines = thread.items.map(i => {
    const also = i.also_on.length > 0 ? ` (also ${i.also_on.join(', ')})` : '';
    const who = i.dir === 'in' ? `Mason via ${i.channel}${also}` : `Leader to ${[i.channel, ...i.also_on].join(', ')}`;
    const tail = i.state === null ? '' : ` — ${masonStateWord(i.state)}${i.job_ids.length > 0 ? ` (${i.job_ids.join(', ')})` : ''}`;
    return `${i.at.slice(0, 16).replace('T', ' ')} ${who}: ${i.text}${tail}`;
  });
  return [...(lines.length > 0 ? lines : [MASON_THREAD_EMPTY]), ...thread.gaps.map(g => `Gap: ${g}`)].join('\n');
}
