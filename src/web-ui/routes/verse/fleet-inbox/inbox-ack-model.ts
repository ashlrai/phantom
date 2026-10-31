import { ackState, ackText, newestLeaderPassMs, parseInboxAt, sourceChip } from '../fleet/interject-ack-model.js';
import type { InboxEntry } from './fleet-inbox-model.js';

export type AnnotatedEntry = InboxEntry & {
  ack: ReturnType<typeof ackState>; ackLabel: string; sourceLabel: string;
};

export function annotateAck(entries: readonly InboxEntry[], runs: unknown, nowMs: number): AnnotatedEntry[] {
  const snapshot = typeof runs === 'object' && runs !== null ? runs as Record<string, unknown> : undefined;
  const leaders = Array.isArray(snapshot?.leaders) ? snapshot.leaders.flatMap((value: unknown) => {
    if (typeof value !== 'object' || value === null) return [];
    const ageSeconds = (value as Record<string, unknown>).ageSeconds;
    return typeof ageSeconds === 'number' || ageSeconds === null ? [{ ageSeconds }] : [];
  }) : undefined;
  const generatedAt = typeof snapshot?.generatedAt === 'string' ? Date.parse(snapshot.generatedAt) : NaN;
  const newestPass = newestLeaderPassMs(leaders, generatedAt);
  return entries.map(entry => {
    const at = newestPass === null ? null : parseInboxAt(entry.at, nowMs);
    const ack = ackState(at, newestPass);
    const minutes = at === null ? 0 : Math.floor(Math.max(0, nowMs - at) / 60_000);
    const age = minutes < 60 ? `${minutes} m` : minutes < 1_440 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1_440)} d`;
    return { ...entry, ack, ackLabel: ack === 'waiting' ? `Waiting for the next pass (posted ${age} ago)`
      : ack === 'unknown' ? 'Unknown' : ackText(ack), sourceLabel: sourceChip(entry.source) };
  });
}

export function seenCounts(entries: readonly AnnotatedEntry[]) {
  return entries.reduce((counts, entry) => {
    if (entry.ack === 'seen') counts.seen++;
    if (entry.ack === 'waiting') counts.waiting++;
    return counts;
  }, { seen: 0, waiting: 0 });
}
