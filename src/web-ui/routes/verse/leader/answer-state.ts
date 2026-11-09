/**
 * routes/verse/leader/answer-state.ts — for each of Mason's messages, has the
 * Leader answered it yet? Pure and browser-safe.
 *
 * Answered = the first later Leader message whose replyTo is its id, else the
 * first later Leader 'message' or 'answer' before Mason's next message.
 * Updates, memos and actions are the Leader talking, not replying.
 */
import type { LeaderThreadMessage } from './thread-types.js';

/** A wait longer than this stands out. */
export const OVERDUE_AFTER_MS = 10 * 60_000;

export type AnswerState =
  | { state: 'answered'; /** id of the answering message. */ answeredBy: string; afterMs: number }
  | { state: 'waiting'; waitingMs: number; overdue: boolean };

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Keyed by the id of every Mason message in `messages` (oldest first). */
export function answerStates(messages: readonly LeaderThreadMessage[], nowMs: number): Map<string, AnswerState> {
  const out = new Map<string, AnswerState>();
  // First Leader reply per replyTo target, with its position.
  const replies = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.from === 'leader' && m.replyTo && !replies.has(m.replyTo)) replies.set(m.replyTo, i);
  });
  messages.forEach((m, i) => {
    if (m.from !== 'mason') return;
    let at = replies.get(m.id) ?? -1;
    if (at <= i) {
      at = -1;
      for (let j = i + 1; j < messages.length; j++) {
        const n = messages[j]!;
        if (n.from === 'mason') break;
        if (n.kind === 'message' || n.kind === 'answer') {
          at = j;
          break;
        }
      }
    }
    const sent = ms(m.at);
    if (at >= 0) {
      const a = messages[at]!;
      out.set(m.id, { state: 'answered', answeredBy: a.id, afterMs: Math.max(0, ms(a.at) - sent) });
    } else {
      const waitingMs = Math.max(0, nowMs - sent);
      out.set(m.id, { state: 'waiting', waitingMs, overdue: waitingMs > OVERDUE_AFTER_MS });
    }
  });
  return out;
}

/** "<1m", "14m", "2h 5m". */
export function formatWait(durationMs: number): string {
  const mins = Math.floor(durationMs / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const rest = mins % 60;
  return rest ? `${Math.floor(mins / 60)}h ${rest}m` : `${Math.floor(mins / 60)}h`;
}
