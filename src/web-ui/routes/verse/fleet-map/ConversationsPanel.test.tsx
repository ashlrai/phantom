import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { buildConversations, type ConversationMessage } from '../../../../core/fleet/agent-conversations.js';
import { ConversationsPanel } from './ConversationsPanel.js';
import { MapView } from './MapPane.js';
import { narrowConversations, threadLines } from './conversations-model.js';
import { narrowLiveMap } from './map-model.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const say = (id: string, from: string, to: string, minutesAgo: number, over: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, from, to, kind: 'status', subject: `${id} words`, at: NOW - minutesAgo * 60_000, replyTo: null, state: null, ...over });
// Three threads: one waiting an hour, one answered, one with an agent no label proves. JSON round trip = what the API sends.
const threads = () => narrowConversations(JSON.parse(JSON.stringify({ schema: 'agents.conversations.v1', version: 1, conversations: buildConversations([
  say('old', 'leader', 'claude', 70, { kind: 'ask', subject: 'who owns docs' }),
  say('q', 'claude', 'grok', 5, { kind: 'ask', subject: 'build ok' }), say('r', 'grok', 'claude', 4, { kind: 'reply', replyTo: 'q', subject: 'yes' }),
  say('u', 'someone', 'claude', 1, { kind: 'status', subject: 'hello' }),
], NOW) })))!;
afterEach(cleanup);

describe('Conversations panel', () => {
  it('lists three threads, the longest wait pinned first, in plain words', () => {
    render(<ConversationsPanel conversations={threads()} now={NOW} selectedId={null} onSelect={() => {}} />);
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('data-pinned', 'true');
    expect(rows[0]!.textContent).toContain('Longest wait: waiting for reply from claude for 1h 10m');
    expect(rows[0]!.textContent).toContain('who owns docs');
    expect(rows[2]!.textContent).toContain('answered');
    expect(rows[2]!.textContent).toContain('2 messages');
    expect(rows[1]!.textContent).toContain('unknown agent (someone)');
  });

  it('opens a thread on select and says unknown or empty plainly', () => {
    const onSelect = vi.fn(), list = threads();
    const { rerender } = render(<ConversationsPanel conversations={list} now={NOW} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /build ok|yes/ }));
    expect(onSelect).toHaveBeenCalledWith('q');
    rerender(<ConversationsPanel conversations={list} now={NOW} selectedId="q" onSelect={onSelect} />);
    expect(within(screen.getByRole('list', { name: 'Thread' })).getAllByRole('listitem')).toHaveLength(2);
    rerender(<ConversationsPanel conversations={null} now={NOW} selectedId={null} onSelect={onSelect} />);
    expect(screen.getByRole('status').textContent).toContain('unknown');
    rerender(<ConversationsPanel conversations={[]} now={NOW} selectedId={null} onSelect={onSelect} />);
    expect(screen.getByText('No agent conversations yet.')).toBeTruthy();
  });
});

describe('thread lines on the map', () => {
  const node = (id: string, kind: string, label: string) => ({ id, kind, label, provider: 'unknown', status: 'running', detail: 'fixture', live: null });
  const map = narrowLiveMap({ schema: 'fleet.live-map.v1', generatedAt: new Date(NOW).toISOString(), windowMinutes: 15, pulseSeconds: 60,
    nodes: [node('leader', 'leader', 'Leader'), node('lane:claude', 'lane', 'claude'), node('lane:grok', 'lane', 'grok')],
    edges: [], counts: { messages: 0 }, sources: { messages: 'available' }, unmappedMessages: 0, gaps: [] })!;

  it('draws only talk from the last 10 minutes, marks the waiting line and opens its thread on click', () => {
    const list = threads();
    // The hour-old ask is outside the window; claude and grok talked 4 minutes ago and nothing waits there.
    expect(threadLines(list, NOW, new Set(['leader', 'lane:claude', 'lane:grok'])).map(l => [l.a, l.b, l.count, l.waiting])).toEqual([['lane:claude', 'lane:grok', 2, false]]);
    const waiting = threads().map(c => c.id === 'q' ? { ...c, state: 'waiting' as const, waiting: { on: 'grok', since: new Date(NOW - 4 * 60_000).toISOString(), ms: 240_000 } } : c);
    waiting[1]!.messages = waiting[1]!.messages.slice(0, 1);
    render(<MapView map={map} now={NOW} onOpen={() => {}} conversations={waiting} reducedMotion />);
    expect(document.querySelectorAll('[data-thread-line]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Waiting for a reply between claude and grok/ }));
    expect(within(screen.getByRole('list', { name: 'Thread' })).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
