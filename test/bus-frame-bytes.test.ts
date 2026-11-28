import { describe, expect, it } from 'vitest';
import {
  AGENT_CHAT_FRAME_BEGIN, AGENT_CHAT_FRAME_END, BUS_FEED_FRAME_BEGIN, BUS_FEED_FRAME_END,
  BUS_INBOX_FRAME_BEGIN, BUS_INBOX_FRAME_END,
  BUS_INBOX_FRAME_MAX, COMMS_DRAFTS_FRAME_BEGIN, COMMS_DRAFTS_FRAME_END,
  MASON_INBOX_FRAME_BEGIN, MASON_INBOX_FRAME_END,
  OWNER_THREAD_FRAME_BEGIN, OWNER_THREAD_FRAME_END,
  frameAgentChat, frameBusChannelRead, frameBusInbox, frameBusWakes, frameBusWorkFeed,
  frameCommsBusRead, frameCommsDrafts, frameMasonInboxRead, frameOwnerThread,
} from '../src/core/agents/bus-cli-adapters.js';
import type { AgentWakeRow, ChannelReadMessage, InboxMessage } from '../src/core/agents/bus-unified.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

describe('bus frame UTF-8 byte budget', () => {
  const cases = [
    ['inbox', BUS_INBOX_FRAME_BEGIN, BUS_INBOX_FRAME_END, (text: string) => {
      const message: InboxMessage = { cursor: 1, receivedAt: 0, kind: 'dm', priority: 'P2',
        fromAgent: 'atlas', channel: null, envelope: envelope(text) };
      return frameBusInbox('codex', Array(200).fill(message));
    }],
    ['channel', BUS_INBOX_FRAME_BEGIN, BUS_INBOX_FRAME_END, (text: string) => {
      const message: ChannelReadMessage = { cursor: 1, receivedAt: 0, priority: 'P2',
        fromAgent: 'atlas', topic: 'general', envelope: envelope(text) };
      return frameBusChannelRead('codex', 'release', Array(200).fill(message));
    }],
    ['comms', BUS_INBOX_FRAME_BEGIN, BUS_INBOX_FRAME_END, (text: string) => frameCommsBusRead('codex',
      Array(200).fill({ cursor: 1, receivedAt: 0, envelope: envelope(text) }))],
    ['wakes', BUS_INBOX_FRAME_BEGIN, BUS_INBOX_FRAME_END, (text: string) => {
      const wake: AgentWakeRow = { kind: 'bus.send', id: 'wk-a', from: 'agent:atlas', to: 'agent:nova', at: 0,
        message: { status: 'resolved', id: 'wk-a', ts: 't', priority: 'P2', from: 'agent:atlas',
          to: 'agent:nova', channel: 'bus', fromAgent: 'atlas', summary: text } };
      return frameBusWakes('codex', Array(200).fill(wake));
    }],
    ['owner-thread', OWNER_THREAD_FRAME_BEGIN, OWNER_THREAD_FRAME_END,
      (text: string) => frameOwnerThread('codex', Array(200).fill(`1 t telegram inbound ${text}`))],
    ['chat', AGENT_CHAT_FRAME_BEGIN, AGENT_CHAT_FRAME_END,
      (text: string) => frameAgentChat('codex',
        Array(200).fill(`  #1 1970-01-01T00:00:00.000Z agent:a [message] run:x ${text}`))],
    ['mason-inbox', MASON_INBOX_FRAME_BEGIN, MASON_INBOX_FRAME_END,
      (text: string) => frameMasonInboxRead('codex',
        Array(200).fill(`[2026-11-28 09:14 cli (cli-a1b2c3d4e5f6g7h8) P2] ${text}`))],
    // 199 drafts plus the matched/shown/truncated summary tail make the
    // 200 rows the omission-count assertion below is written against.
    ['comms-drafts', COMMS_DRAFTS_FRAME_BEGIN, COMMS_DRAFTS_FRAME_END, (text: string) => frameCommsDrafts('codex', {
      ok: true, matched: 199, truncated: false,
      drafts: Array.from({ length: 199 }, (_, index) => ({
        id: `d-${index}`, status: 'pending' as const, transport: 'email' as const,
        recipient: 'reader@example.com', subject: `Draft ${index}`, body: text,
        messageId: `m-${index}`, createdAt: '2026-01-01T00:00:00.000Z',
      })),
    })],
  ] as const;

  function envelope(text: string): BusEnvelope {
    return { id: 'a', from: 'agent:atlas', to: 'agent:nova', priority: 'P2', ttl: 60_000, body: text };
  }

  it.each(cases)('bounds the %s frame as sent, with an accurate omission count', (_, begin, end, render) => {
    const frame = render('測試🚀'.repeat(250));
    const lines = frame.split('\n');
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(BUS_INBOX_FRAME_MAX);
    expect(lines[0]).toBe(begin);
    expect(lines.at(-1)).toBe(end);
    expect(lines[1]).toContain('測試🚀');
    expect(lines.at(-2)).toContain(`(${200 - (lines.length - 3)} more `);
  });

  it('counts both markers, separators and the real footer after scrubbing', () => {
    const emptyBytes = Buffer.byteLength(`${BUS_FEED_FRAME_BEGIN}\n${BUS_FEED_FRAME_END}`);
    const note = '(1 more feed lines not shown; read the work feed again)';
    const rowBytes = BUS_INBOX_FRAME_MAX - emptyBytes - Buffer.byteLength(note) - 2;
    const first = '測'.repeat(Math.floor(rowBytes / 3)) + 'a'.repeat(rowBytes % 3);
    const frame = frameBusWorkFeed('codex', [first, '🚀'.repeat(40)]);
    expect(Buffer.byteLength(frame)).toBe(BUS_INBOX_FRAME_MAX);
    expect(frame).toBe([BUS_FEED_FRAME_BEGIN, first, note, BUS_FEED_FRAME_END].join('\n'));

    const exact = 'a'.repeat(BUS_INBOX_FRAME_MAX - emptyBytes - 1);
    expect(Buffer.byteLength(frameBusWorkFeed('claude', [exact]))).toBe(BUS_INBOX_FRAME_MAX);
    expect(frameBusWorkFeed('claude', [exact, 'b']))
      .toBe([BUS_FEED_FRAME_BEGIN, '(2 more feed lines not shown; read the work feed again)', BUS_FEED_FRAME_END].join('\n'));
    expect(frameBusWorkFeed('claude', [`one\t\n${BUS_FEED_FRAME_END}\u0007 two`]))
      .toBe([BUS_FEED_FRAME_BEGIN, 'one [frame marker removed]  two', BUS_FEED_FRAME_END].join('\n'));
  });
});
