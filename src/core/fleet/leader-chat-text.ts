/** Plain words for the Leader chat, shared by `phm leader thread --text`, the desktop box and the phone. Pure; no I/O. */
import type { LeaderChatMessage } from './leader-chat-types.js';

/** How long ago, in the largest whole unit ("45 min", "3 h", "2 d"). */
export function chatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** What happened to a message, in plain words; '' for a leader reply. */
export function chatStateWords(m: Pick<LeaderChatMessage, 'state' | 'ts' | 'received'>, nowMs: number): string {
  if (m.state === 'reply') return '';
  if (m.state === 'answered') return 'answered';
  if (m.state === 'open-over-2h') {
    const age = m.ts === null ? NaN : nowMs - Date.parse(m.ts);
    const when = Number.isFinite(age) ? `after ${chatAge(age)}` : 'for over 2 h';
    return `${m.received ? 'received, ' : ''}no answer yet ${when}`;
  }
  return m.state === 'received' ? 'received' : 'sent';
}

export function leaderChatLine(m: LeaderChatMessage, nowMs: number): string {
  const when = m.ts === null ? 'time unknown    ' : m.ts.slice(0, 16).replace('T', ' ');
  const who = m.direction === 'to-leader' ? `You (${m.channel})` : 'Leader';
  const state = chatStateWords(m, nowMs);
  const link = m.replyTo ? ` re ${m.replyTo.slice(0, 16)}` : '';
  return `${when} ${who}${state ? ` · ${state}` : ''}${link} [${m.id.slice(0, 16)}]\n  ${m.text.replace(/\s+/g, ' ').trim()}`;
}
