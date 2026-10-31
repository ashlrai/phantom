/**
 * routes/verse/leader-thread/thread-merge-model.ts — the Leaders dock pane's
 * ONE conversation: the leaders' thread posts interleaved in time with the
 * entries of MASON-INBOX.md, whatever channel they arrived on, so a leader's
 * answer sits under the words it answered. Pure; the tests feed the shapes.
 */
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { parseInboxAt, sourceChip } from '../fleet/interject-ack-model.js';
import { CHANNEL_LABEL, displayThreadText } from '../leader/thread-model.js';
import { LEADER_THREAD_CHANNELS, type LeaderThreadChannel, type LeaderThreadMessage } from '../leader/thread-types.js';

/** What the merge needs of a thread post; the wire message covers it. */
export type ThreadPostShape = Pick<LeaderThreadMessage, 'id' | 'at' | 'from' | 'channel' | 'kind' | 'text'>;

export interface MergedLine {
  /** Epoch ms, or NaN when the timestamp could not be read. */
  at: number;
  who: 'mason' | 'leader';
  /** The post's channel, or the inbox entry's declared source. */
  source: string;
  text: string;
  id: string;
}

export interface MergedThread {
  /** Dated lines, oldest first; an inbox entry wins a tie with a thread post. */
  lines: MergedLine[];
  /** Entries whose timestamps could not be read (`at` is NaN); the pane renders them after `lines`. */
  undated: MergedLine[];
}

/** MASON-INBOX.md writes "YYYY-MM-DD HH:MM" ET wall times (parseInboxAt); anything else, e.g. ISO, falls back to Date.parse. */
function inboxMs(at: string, nowMs: number): number {
  return parseInboxAt(at, nowMs) ?? Date.parse(at);
}

export function mergeThread(thread: readonly ThreadPostShape[], inbox: FleetRunsV1['inbox'], nowMs: number): MergedThread {
  // An interjection relayed into the thread lands there verbatim; the inbox
  // copy is dropped so the message shows once, still attributed to Mason.
  const relayed = new Set(thread.filter(m => m.from === 'mason').map(m => m.text.trim()));
  // All inbox entries sort before all thread posts at a shared timestamp —
  // Mason's words, then the answer to them.
  const dated: { line: MergedLine; order: number }[] = [];
  const undated: MergedLine[] = [];
  let order = 0;
  const push = (line: MergedLine) => {
    if (Number.isFinite(line.at)) dated.push({ line, order: order++ });
    else undated.push(line);
  };
  inbox.forEach((entry, index) => {
    if (relayed.has(entry.text.trim())) return;
    push({ at: inboxMs(entry.at, nowMs), who: 'mason', source: entry.source, text: entry.text, id: `inbox-${index}` });
  });
  for (const message of thread) {
    push({ at: Date.parse(message.at), who: message.from, source: message.channel, text: displayThreadText(message), id: message.id });
  }
  dated.sort((a, b) => a.line.at - b.line.at || a.order - b.order);
  return { lines: dated.map(d => d.line), undated };
}

/** The thread channel this source names, or null for a free-form inbox source. */
export function lineChannel(source: string): LeaderThreadChannel | null {
  const lower = source.trim().toLowerCase();
  return (LEADER_THREAD_CHANNELS as readonly string[]).includes(lower) ? (lower as LeaderThreadChannel) : null;
}

/** What the source chip says: the channel's own label when there is one, else the inbox's normalised source. */
export function lineSourceLabel(source: string): string {
  const channel = lineChannel(source);
  return channel ? CHANNEL_LABEL[channel] : sourceChip(source);
}

/** The inbox array inside a /api/verse/fleet/runs read — [] when the read has none. */
export function fleetInbox(data: unknown): FleetRunsV1['inbox'] {
  const rows = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as FleetRunsV1).inbox : undefined;
  return Array.isArray(rows) && rows.every(row => row && typeof row.at === 'string' && typeof row.source === 'string' && typeof row.text === 'string') ? rows : [];
}
