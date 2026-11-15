/**
 * interject-receipt.ts — the proof line under a sent interjection.
 *
 * Pure: derives what actually happened from the send result and the bus page,
 * never from hope. A failed send is `failed`; the bus event id and the ack are
 * shown only once a real bus event is observed (never imply routing without a
 * receipt).
 */
import type { AgentBusReceipt } from './fleet-bus/agent-bus-queries.js';

export type InterjectSend =
  | { phase: 'sending'; text: string; sentAtMs: number }
  | { phase: 'failed'; text: string; sentAtMs: number; error?: string }
  | { phase: 'sent'; text: string; sentAtMs: number; duplicate?: boolean };

export interface InterjectReceipt {
  state: 'sending' | 'received' | 'acknowledged' | 'failed';
  inboxWritten: boolean;
  busEventId?: string;
  ackBy?: string;
  ackAt?: string;
  text: string;
}

/** Bus receivedAt is stamped by the server; allow some clock skew. */
const SKEW_MS = 5 * 60_000;
const REPLY_KEYS = ['inReplyTo', 'in_reply_to', 'replyTo'] as const;

const body = (row: AgentBusReceipt): Record<string, unknown> | null => {
  const b = row.envelope.body;
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? b as Record<string, unknown> : null;
};

export function clockTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const shortBusId = (id: string): string => id.length > 8 ? id.slice(-8) : id;

export function buildInterjectReceipt(send: InterjectSend, busEvents: readonly AgentBusReceipt[], _now: number = Date.now()): InterjectReceipt {
  if (send.phase === 'sending') return { state: 'sending', inboxWritten: false, text: 'sending…' };
  if (send.phase === 'failed') {
    return { state: 'failed', inboxWritten: false, text: `not sent${send.error ? ` · ${send.error}` : ''}` };
  }
  const received = `received ${clockTime(send.sentAtMs)}`;
  const inbox = send.duplicate ? 'already in inbox' : 'inbox line written';
  const wanted = send.text.trim();
  // Earliest matching mirror: from Mason, an interjection, same text, not older than this send.
  const mirror = [...busEvents]
    .filter(row => {
      const b = body(row);
      return row.envelope.from === 'mason' && b?.kind === 'interjection'
        && typeof b.text === 'string' && b.text.trim() === wanted
        && row.receivedAt >= send.sentAtMs - SKEW_MS;
    })
    .sort((a, c) => a.cursor - c.cursor)[0];
  if (!mirror) return { state: 'received', inboxWritten: true, text: `${received} · ${inbox} · awaiting bus event` };
  const busEventId = mirror.envelope.id;
  const base = `${received} · ${inbox} · bus event ${shortBusId(busEventId)}`;
  const ack = [...busEvents]
    .filter(row => row.cursor > mirror.cursor && row.envelope.id !== busEventId && row.envelope.from !== 'mason'
      && REPLY_KEYS.some(key => body(row)?.[key] === busEventId))
    .sort((a, c) => a.cursor - c.cursor)[0];
  if (!ack) return { state: 'received', inboxWritten: true, busEventId, text: base };
  const ackAt = clockTime(ack.receivedAt);
  return { state: 'acknowledged', inboxWritten: true, busEventId, ackBy: ack.envelope.from, ackAt,
    text: `${base} · acknowledged by ${ack.envelope.from} ${ackAt}` };
}
