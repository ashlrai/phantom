import { newestLeaderPassMs } from '../fleet/interject-ack-model.js';
import { etaText, LEADER_PASS_CADENCE_MS, nextPassEta } from '../fleet/next-pass-eta.js';
import type { InboxSeen } from './inbox-seen-model.js';

export function inboxPending(seen: readonly InboxSeen[], snapshot: { generatedAt: string; leaders: ReadonlyArray<{ ageSeconds: number | null }> } | undefined, nowMs: number):
  { waiting: number; text: string; tone: 'ok' | 'warning' | 'danger' } {
  const waiting = seen.filter(entry => entry.tone !== 'ok').length;
  if (waiting === 0) return { waiting, text: 'All messages seen by a leader', tone: 'ok' };
  const pass = newestLeaderPassMs(snapshot?.leaders, Date.parse(snapshot?.generatedAt ?? ''));
  const eta = nextPassEta(pass, nowMs);
  const timing = eta.kind === 'due-in' ? `next due in ${eta.minutes} min` : etaText(eta);
  return {
    waiting,
    text: `${waiting} waiting for a leader pass · ${timing}`,
    tone: eta.kind === 'overdue' && pass !== null && nowMs - pass - LEADER_PASS_CADENCE_MS > 30 * 60_000 ? 'danger' : 'warning',
  };
}
