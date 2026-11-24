import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeaderChat } from '../../../../core/fleet/leader-chat-types.js';
import { LeaderChatList, leaderChatFrom } from './LeaderChat.js';

const NOW = Date.parse('2026-11-17T15:00:00Z');
const chat: LeaderChat = {
  v: 1, generatedAt: '2026-11-17T15:00:00.000Z', skipped: { malformedInbox: 0 },
  messages: [
    { id: 'desk-1', ts: '2026-11-17T11:00:00.000Z', direction: 'to-leader', channel: 'desktop', text: 'Old question', state: 'open-over-2h', received: true },
    { id: 'phone-1', ts: '2026-11-17T14:30:00.000Z', direction: 'to-leader', channel: 'phone', text: 'Is the release green?', state: 'answered', received: false },
    { id: 'out-1', ts: '2026-11-17T14:40:00.000Z', direction: 'from-leader', channel: 'outbox', text: 'Yes, green.', state: 'reply', replyTo: 'phone-1' },
    { id: 'phone-2', ts: '2026-11-17T14:50:00.000Z', direction: 'to-leader', channel: 'phone', text: 'Ship it', state: 'received', received: true },
    { id: 'phone-3', ts: null, direction: 'to-leader', channel: 'phone', text: 'Undated', state: 'sent', received: false },
  ],
};
const initialWidth = window.innerWidth;
afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth }); });

describe('LeaderChatList', () => {
  it('shows the empty state in plain words', () => {
    render(<LeaderChatList chat={{ ...chat, messages: [] }} nowMs={NOW} />);
    expect(screen.getByRole('status')).toHaveTextContent('No messages yet. Write one below and the leader will see it.');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders oldest first with the newest at the bottom, ticks, answered and the 2-hour flag', () => {
    render(<LeaderChatList chat={chat} nowMs={NOW} />);
    const items = within(screen.getByRole('list', { name: 'Conversation with the leader' })).getAllByRole('listitem');
    expect(items.map(item => item.dataset.state)).toEqual(['open-over-2h', 'answered', 'reply', 'received', 'sent']);
    expect(items[0]).toHaveTextContent('✓ received, no answer yet after 4 h');
    expect(items[1]).toHaveTextContent('✓ answered');
    expect(items[2]).toHaveTextContent(/^Leader ·.*Yes, green\.$/);
    expect(items[3]).toHaveTextContent('✓ received');
    expect(items[4]).toHaveTextContent('You · time unknown');
    expect(items[4]).toHaveTextContent(/sent$/);
    expect(items[4]!.style.alignSelf).toBe('flex-end');
    expect(items[2]!.style.alignSelf).toBe('flex-start');
  });

  it('puts a small channel badge on every message, also at phone width (390 px)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<div style={{ width: 390 }}><LeaderChatList chat={chat} nowMs={NOW} /></div>);
    expect(screen.getAllByTestId('channel-badge').map(badge => badge.textContent)).toEqual(['desktop', 'phone', 'outbox', 'phone', 'phone']);
    expect(screen.getAllByRole('listitem').at(-1)).toHaveTextContent('Undated');
  });

  it('fits a narrow phone: bubbles wrap long words inside a percentage width', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    const long = { ...chat, messages: [{ ...chat.messages[3]!, text: 'x'.repeat(400) }] };
    render(<div style={{ width: 320 }}><LeaderChatList chat={long} nowMs={NOW} /></div>);
    const item = screen.getByRole('listitem');
    expect(item.style.maxWidth).toBe('85%');
    expect(item.style.overflowWrap).toBe('anywhere');
    expect(screen.getByRole('list').style.overflowY).toBe('auto');
  });

  it('reads the chat from a fleet runs payload and treats an older build as unknown', () => {
    expect(leaderChatFrom({ leaderChat: chat })).toBe(chat);
    expect(leaderChatFrom({ inbox: [] })).toBeNull();
    expect(leaderChatFrom({ leaderChat: { ...chat, messages: [{ id: 1 }] } })).toBeNull();
  });
});
