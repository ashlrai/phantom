/**
 * RQ-PHX-DOTREPLYGAP09: how long has a teammate text (Dot / "Ashlr.") waited
 * for a reply? Metadata only: no bodies, no handles or sender ids, only a
 * display label and timestamps. Reads nothing and sends nothing.
 */
import { readTeammateTexts } from './imessage-teammate-inbox.js';

export interface ReplyGapEvent { teammate: string; direction: 'inbound' | 'outbound'; at: number }
export interface TeammateReplyGap {
  teammate: string;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  unansweredCount: number;
  oldestUnansweredMs: number;
  state: 'ok' | 'late' | 'unknown';
}

/** `events` is null when there is no evidence source: the answer is then `unknown`, never `ok`. */
export function teammateReplyGap(events: readonly ReplyGapEvent[] | null, now: number, opts: { warnAfterMs?: number } = {}): TeammateReplyGap[] {
  const warnAfterMs = opts.warnAfterMs ?? 5 * 60_000;
  if (events === null) return [{ teammate: 'Teammates', lastInboundAt: null, lastOutboundAt: null, unansweredCount: 0, oldestUnansweredMs: 0, state: 'unknown' }];
  const byTeammate = new Map<string, ReplyGapEvent[]>();
  for (const event of events) {
    if (!Number.isFinite(event.at)) continue;
    byTeammate.set(event.teammate, [...(byTeammate.get(event.teammate) ?? []), event]);
  }
  return [...byTeammate].map(([teammate, rows]) => {
    const at = (direction: ReplyGapEvent['direction']) => rows.filter(row => row.direction === direction).map(row => row.at);
    const inbound = at('inbound');
    const lastInboundAt = inbound.length ? Math.max(...inbound) : null;
    const outbound = at('outbound');
    const lastOutboundAt = outbound.length ? Math.max(...outbound) : null;
    const waiting = inbound.filter(time => lastOutboundAt === null || time > lastOutboundAt);
    const oldestUnansweredMs = waiting.length ? Math.max(0, now - Math.min(...waiting)) : 0;
    return { teammate, lastInboundAt, lastOutboundAt, unansweredCount: waiting.length, oldestUnansweredMs,
      state: waiting.length && oldestUnansweredMs >= warnAfterMs ? 'late' as const : 'ok' as const };
  }).sort((a, b) => a.teammate.localeCompare(b.teammate));
}

/**
 * Reads the local teammate inbox. An answered marker records no time, so an
 * answered text counts as an outbound at its own receipt time (a lower bound
 * that can only under-report lateness, never invent it).
 */
export function teammateReplyGapFromInbox(now: number, runsDir?: string, labels: Readonly<Record<string, string>> = {}): TeammateReplyGap[] {
  const all = readTeammateTexts({ runsDir, includeAnswered: true, now: () => now });
  if (all.sourceState === 'missing') return teammateReplyGap(null, now);
  const open = new Set(readTeammateTexts({ runsDir, now: () => now }).texts.map(text => text.rowid));
  const events = all.texts.flatMap((text): ReplyGapEvent[] => {
    const teammate = Object.hasOwn(labels, text.senderId) ? labels[text.senderId]! : 'Teammate';
    const at = Date.parse(text.at);
    return open.has(text.rowid) ? [{ teammate, direction: 'inbound', at }]
      : [{ teammate, direction: 'inbound', at }, { teammate, direction: 'outbound', at }];
  });
  return teammateReplyGap(events, now);
}
