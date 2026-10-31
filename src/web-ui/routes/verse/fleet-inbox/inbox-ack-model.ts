import { ackState, ackText, newestLeaderPassMs, parseInboxAt, sourceChip } from '../fleet/interject-ack-model.js';
import { etaText, nextPassEta } from '../fleet/next-pass-eta.js';
import type { InboxEntry } from './fleet-inbox-model.js';

export type AnnotatedEntry = InboxEntry & {
  ack: ReturnType<typeof ackState>; ackLabel: string; sourceLabel: string; eta: ReturnType<typeof nextPassEta>;
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
  const eta = nextPassEta(newestPass, nowMs);
  return entries.map(entry => {
    const at = newestPass === null ? null : parseInboxAt(entry.at, nowMs);
    const ack = ackState(at, newestPass);
    return { ...entry, ack, eta, ackLabel: ack === 'waiting' ? `Waiting · ${etaText(eta)}`
      : ack === 'unknown' ? 'Unknown' : ackText(ack), sourceLabel: sourceChip(entry.source) };
  });
}

export function seenCounts(entries: readonly AnnotatedEntry[]) {
  return entries.reduce((counts, entry) => {
    if (entry.ack === 'seen') counts.seen++;
    if (entry.ack === 'waiting') { counts.waiting++; counts.overdue ||= entry.eta.kind === 'overdue'; }
    return counts;
  }, { seen: 0, waiting: 0, overdue: false });
}
