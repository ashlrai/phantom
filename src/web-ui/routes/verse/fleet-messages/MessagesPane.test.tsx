import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { getPane } from '../panes/pane-registry.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { OrgPane } from '../fleet-org/OrgPane.js';
import { MessagesPane } from './MessagesPane.js';
import { showMessagePair } from './messages-pair.js';
import { talkingNow, type AgentMessage } from './messages-model.js';
import './fleet-messages.pane.js';

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const msg = (over: Partial<AgentMessage>): AgentMessage => ({
  id: 'x', ts: at(1), priority: 'P2', from: { name: 'claude-1', lane: 'claude' }, to: { name: 'codex-local-2', lane: 'codex-local' },
  kind: 'status', summary: 'hello', conversation: 'c1', job: null, pr: null, ...over,
});
const messages = [
  msg({ id: 'm3', ts: at(1), from: { name: 'grok-3', lane: null }, to: { name: 'claude-1', lane: 'claude' }, kind: 'reply', summary: 'Reviewed, looks good', conversation: 't-chain' }),
  msg({ id: 'm2', ts: at(2), from: { name: 'codex-local-2', lane: 'codex-local' }, to: { name: 'grok-3', lane: null }, kind: 'ask', summary: 'Can you review?', conversation: 't-chain', pr: 'ashlrai/phantom#6670' }),
  msg({ id: 'm1', ts: at(3), kind: 'handoff', summary: 'Take over the parser fix', conversation: 't-chain', job: 'RQ-PHX-CHAINA1' }),
  msg({ id: 'old', ts: at(60), from: { name: 'leader', lane: 'leader' }, to: { name: 'devin-1', lane: 'devin' }, kind: 'blocker', summary: 'CI red', conversation: 'pair:devin-1|leader' }),
];
const page = (rows: AgentMessage[], skipped = 0) => ({ schema: 'agent-messages.v1', source: rows.length ? 'available' : 'missing', messages: rows, matched: rows.length, skipped });

function stub(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(map).find(([path]) => url.includes(path));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  }));
}
beforeEach(() => { evictAll(); resetWorkerLogSelection(); showMessagePair(null); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetWorkerLogSelection(); });

it('registers a session-independent Messages pane', () => {
  expect(getPane('fleet-messages')).toMatchObject({ id: 'fleet-messages', title: 'Messages', needsSession: false });
});

it('shows a plain empty state for an empty bus', async () => {
  stub({ '/api/verse/agent-bus/messages': page([]) });
  render(<MessagesPane {...{ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps} />);
  expect(await screen.findByText(/No agent messages yet/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '0 conversations' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('says unknown, not empty, when the bus cannot be read', async () => {
  stub({});
  render(<MessagesPane {...{ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps} />);
  expect(await screen.findByText(/Agent messages unknown/)).toBeInTheDocument();
});

it('groups by conversation with names and lanes, opens the job on click, and filters by agent', async () => {
  stub({ '/api/verse/agent-bus/messages': page(messages, 2) });
  const openPane = vi.fn();
  render(<MessagesPane {...{ visible: true, host: { openPane } } as unknown as PaneProps} />);
  expect(await screen.findByRole('heading', { name: '2 conversations' })).toBeInTheDocument();
  expect(screen.getByText('Skipped 2 damaged bus records.')).toBeInTheDocument();
  const chain = screen.getByRole('listitem', { name: 'Conversation: claude-1, codex-local-2, grok-3' });
  const rows = within(chain).getAllByText(/Take over|Can you review|Reviewed/).map(n => n.textContent);
  // Oldest to newest inside a conversation, each with from and to as name · lane.
  expect(rows).toEqual([
    'claude-1 · claude → codex-local-2 · codex-local: Take over the parser fix · RQ-PHX-CHAINA1',
    'codex-local-2 · codex-local → grok-3 · lane unknown: Can you review?',
    'grok-3 · lane unknown → claude-1 · claude: Reviewed, looks good',
  ]);
  expect(within(chain).getByRole('link', { name: 'PR ashlrai/phantom#6670' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/6670');

  fireEvent.click(within(chain).getByRole('button', { name: /Open job RQ-PHX-CHAINA1/ }));
  expect(openPane).toHaveBeenCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-PHX-CHAINA1');

  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'devin-1' } });
  expect(screen.getByRole('heading', { name: '1 conversation' })).toBeInTheDocument();
  expect(screen.getByText('CI red')).toBeInTheDocument();
  expect(screen.queryByText('Reviewed, looks good')).toBeNull();
});

it('draws one line per conversation from the last 15 minutes', () => {
  expect(talkingNow(messages, now).map(l => [l.a.name, l.b.name, l.messages])).toEqual([['claude-1', 'codex-local-2', 3]]);
});

it('shows talking-now lines in the Org pane from the same API', async () => {
  stub({ '/api/verse/agent-bus/messages': page(messages) });
  render(<OrgPane {...{ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps} />);
  const talk = await screen.findByRole('region', { name: 'Talking now' });
  expect(await within(talk).findByRole('img', { name: 'claude-1 and codex-local-2: 3 messages' })).toBeInTheDocument();
});

it('narrows to the last 20 messages between two agents when a pair is chosen, and Show all returns', async () => {
  stub({ 'agent=leader&with=devin-1&limit=20': page([messages[3]!]), '/api/verse/agent-bus/messages?limit=200': page(messages) });
  showMessagePair(['leader', 'devin-1']);
  render(<MessagesPane {...{ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps} />);
  expect(await screen.findByText('leader ↔ devin-1 · last 20 messages')).toBeInTheDocument();
  expect(await screen.findByText('CI red')).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
  expect(await screen.findByRole('heading', { name: '2 conversations' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Agent' })).toBeInTheDocument();
});

it('says so when the chosen pair has no messages', async () => {
  stub({ '/api/verse/agent-bus/messages': page([]) });
  showMessagePair(['leader', 'zai']);
  render(<MessagesPane {...{ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps} />);
  expect(await screen.findByText('No messages between leader and zai.')).toBeInTheDocument();
});
