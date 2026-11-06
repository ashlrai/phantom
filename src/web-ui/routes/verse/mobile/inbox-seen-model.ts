import { newestLeaderPassMs } from '../fleet/interject-ack-model.js';
import { annotateAck, seenCounts } from '../fleet-inbox/inbox-ack-model.js';
import { mobileTime } from './interject-ack-model.js';
import type { FleetInboxReadEntry } from './inbox-read-query.js';

export type InboxSeen = { ackLabel: string; tone: 'ok' | 'neutral' | 'warning' };

/** Keep the desktop's acknowledgment and ETA rules while adapting its entry shape. */
export function inboxSeen(entries: readonly FleetInboxReadEntry[], snapshot: { generatedAt: string; leaders: ReadonlyArray<{ ageSeconds: number | null }> } | undefined, nowMs: number):
  { entries: InboxSeen[]; waiting: number; overdue: boolean } {
  const annotated = annotateAck(entries.map(entry => ({ ...entry, priority: entry.priority ?? '—' })), snapshot, nowMs);
  const { waiting, overdue } = seenCounts(annotated);
  const pass = newestLeaderPassMs(snapshot?.leaders, Date.parse(snapshot?.generatedAt ?? ''));
  return {
    entries: annotated.map(entry => {
      if (entry.ack === 'seen' && pass !== null) return { ackLabel: `Seen by leaders ${mobileTime(new Date(pass).toISOString())}`, tone: 'ok' };
      if (entry.ack === 'waiting' && entry.eta.kind === 'overdue') return { ackLabel: 'Waiting · leader pass overdue', tone: 'warning' };
      if (entry.ack === 'waiting' && entry.eta.kind === 'due-in') return { ackLabel: `Waiting · next pass due in about ${entry.eta.minutes} min`, tone: 'neutral' };
      return { ackLabel: 'Leader status unknown', tone: 'neutral' };
    }),
    waiting, overdue,
  };
}
