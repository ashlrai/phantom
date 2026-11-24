/**
 * The Leader chat as a conversation: Mason's messages on the right, the
 * leader's replies on the left, newest at the bottom, each message with a small
 * "received" tick and "answered" once a reply links to it; an unanswered
 * message older than 2 hours says so in plain words. Render only: the desktop
 * inbox box and the phone box own the one text box and Send, and both read the
 * `leaderChat` field of GET /api/verse/fleet/runs (core/fleet/leader-chat.ts).
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { chatStateWords } from '../../../../core/fleet/leader-chat-text.js';
import type { LeaderChat, LeaderChatMessage } from '../../../../core/fleet/leader-chat-types.js';

const STATES = new Set(['sent', 'received', 'answered', 'open-over-2h', 'reply']);

function isMessage(value: unknown): value is LeaderChatMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return typeof m.id === 'string' && (m.ts === null || typeof m.ts === 'string') && (m.direction === 'to-leader' || m.direction === 'from-leader')
    && typeof m.channel === 'string' && typeof m.text === 'string' && STATES.has(String(m.state));
}

/** The chat inside a fleet runs read, or null when this build or read has none (unknown, not empty). */
export function leaderChatFrom(data: unknown): LeaderChat | null {
  const chat = data && typeof data === 'object' ? (data as { leaderChat?: unknown }).leaderChat : undefined;
  if (!chat || typeof chat !== 'object') return null;
  const { messages, generatedAt } = chat as Partial<LeaderChat>;
  return Array.isArray(messages) && messages.every(isMessage) && typeof generatedAt === 'string' ? chat as LeaderChat : null;
}

function clock(ts: string | null): string {
  if (ts === null) return 'time unknown';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? 'time unknown' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' };
const bubble: CSSProperties = { maxWidth: '85%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', padding: '6px 10px', borderRadius: 10, border: '1px solid var(--border, rgba(127,127,127,.3))' };
const badge: CSSProperties = { padding: '0 6px', borderRadius: 999, border: '1px solid var(--border, rgba(127,127,127,.3))' };
const meta: CSSProperties = { display: 'block', fontSize: '0.75em', opacity: 0.75, marginTop: 2 };

export function LeaderChatList({ chat, nowMs = Date.now(), limit = 20 }: { chat: LeaderChat; nowMs?: number; limit?: number }) {
  const ref = useRef<HTMLOListElement>(null);
  const shown = chat.messages.slice(-limit);
  const newest = shown[shown.length - 1]?.id;
  // Keep the newest message in view, like any chat.
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [newest]);
  if (shown.length === 0) return <p role="status">No messages yet. Write one below and the leader will see it.</p>;
  return <ol ref={ref} aria-label="Conversation with the leader" style={list}>
    {shown.map(m => {
      const mine = m.direction === 'to-leader';
      const words = chatStateWords(m, nowMs);
      const late = m.state === 'open-over-2h';
      return <li key={m.id} data-direction={m.direction} data-state={m.state} style={{ ...bubble, alignSelf: mine ? 'flex-end' : 'flex-start' }}>
        <span style={{ ...meta, marginTop: 0 }}>{mine ? 'You' : 'Leader'} · {clock(m.ts)} · <span data-testid="channel-badge" style={badge}>{m.channel}</span></span>
        {m.text}
        {words ? <span style={{ ...meta, fontWeight: late ? 600 : undefined, color: late ? 'var(--warning, #b45309)' : undefined }}>{m.state === 'answered' || m.received ? '✓ ' : ''}{words}</span> : null}
      </li>;
    })}
  </ol>;
}
