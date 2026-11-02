import { fleetInbox, lineSourceLabel, mergeThread, type MergedLine, type ThreadPostShape } from '../leader-thread/thread-merge-model.js';

export interface InboxLine extends MergedLine {
  label: string;
  key: string;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const signature = (text: string, at: number) => JSON.stringify([text.trim(), Math.floor(at / 60_000)]);

/** Inbox-only additions; unavailable sources quietly leave the thread alone. */
export function inboxLinesFor(runs: unknown, threadMessages: readonly ThreadPostShape[], nowMs: number): InboxLine[] {
  if (!record(runs) || !record(runs['sources']) || runs['sources']['inbox'] !== 'healthy') return [];
  const relayed = new Set(threadMessages.filter(message => message.from === 'mason')
    .map(message => signature(message.text, Date.parse(message.at))));
  // Merge the inbox alone: the desktop helper's text-only dedupe would also
  // suppress a repeated order from a different minute.
  const merged = mergeThread([], fleetInbox(runs), nowMs);
  const occurrences = new Map<string, number>();
  return merged.lines.filter(line => !relayed.has(signature(line.text, line.at))).map(line => {
    const identity = JSON.stringify([line.source, line.text, line.at]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { ...line, label: lineSourceLabel(line.source), key: `fleet-inbox:${identity}:${occurrence}` };
  });
}
