import { ackState, ackText, newestLeaderPassMs, parseInboxAt } from '../fleet/interject-ack-model.js';
import { nextPassEta } from '../fleet/next-pass-eta.js';

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function postAckLine(result: { at: string; duplicate?: boolean } | null, runs: unknown, nowMs: number):
  { text: string; tone: 'neutral' | 'ok' | 'warning' } | null {
  if (!result) return null;
  if (result.duplicate) return { text: 'Already in the inbox (same text within the dedupe window)', tone: 'warning' };
  const entryMs = parseInboxAt(result.at, nowMs) ?? (/^\d{4}-\d\d-\d\dT/.test(result.at) ? Date.parse(result.at) : NaN);
  if (!Number.isFinite(entryMs)) return { text: `Landed · ${ackText('unknown')}`, tone: 'neutral' };
  const snapshot = typeof runs === 'object' && runs !== null ? runs as Record<string, unknown> : undefined;
  const leaders = Array.isArray(snapshot?.leaders) ? snapshot.leaders.flatMap((leader: unknown) => {
    if (typeof leader !== 'object' || leader === null) return [];
    const ageSeconds = (leader as Record<string, unknown>).ageSeconds;
    return typeof ageSeconds === 'number' || ageSeconds === null ? [{ ageSeconds }] : [];
  }) : undefined;
  const pass = newestLeaderPassMs(leaders, typeof snapshot?.generatedAt === 'string' ? Date.parse(snapshot.generatedAt) : NaN);
  if (ackState(entryMs, pass) === 'seen' && pass !== null) {
    return { text: ackText('seen').replace('a leader pass', `the ${clock.format(pass)} pass`), tone: 'ok' };
  }
  const eta = nextPassEta(pass, nowMs);
  const waiting = ackText('waiting').replace('Waiting', 'waiting').replace(' (every 15 min)', '');
  return { text: `Landed ${clock.format(entryMs)} · ${waiting}${eta.kind === 'due-in' ? ` (about ${eta.minutes} min)` : ''}`, tone: 'neutral' };
}
