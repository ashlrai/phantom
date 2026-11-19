import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { mergeByTime, busRepliesToMason } from './thread-bus-replies.js';
import { appActionRows } from '../fleet-bus/app-action-envelope.js';
import { threadMatches } from './thread-find-model.js';

const now = Date.now();
const status = { v: 1, source: 'available', retainedCount: 110, retainedBytes: 1, liveCount: 110, expiredCount: 0, maxMessages: 1024, maxBytes: 1048576 };
const feed = (cursor: number, ago: number, body: Record<string, unknown>): AgentBusReceipt => ({ cursor, receivedAt: now - ago,
  envelope: { id: `apps-control-${cursor}`, from: 'apps-control', to: 'mason', priority: 'P3', ttl: 604_800_000, body: { kind: 'apps-control', ...body } } });
const reply: AgentBusReceipt = { cursor: 99, receivedAt: now - 5_000,
  envelope: { id: 'ack-1', from: 'claude-leader', to: 'mason', priority: 'P2', ttl: 100_000, body: { kind: 'ack', text: 'Got it' } } };
const actions = [
  feed(11, 25_000, { phase: 'start', action: 'quit', app: 'Slack' }),
  feed(12, 23_800, { phase: 'result', action: 'quit', app: 'Slack', outcome: 'refused', detail: 'that app is never available to agents.' }),
  feed(13, 18_000, { phase: 'start', action: 'open', app: 'Figma' }),
  feed(14, 17_600, { phase: 'result', action: 'open', app: 'Figma', outcome: 'needs-you', detail: 'App-level action requested for review. Sent to needs-you.' }),
  feed(15, 4_000, { phase: 'start', action: 'focus', app: 'Notes' }),
];
const routes = (messages: AgentBusReceipt[]) => ({
  '/api/verse/leader/thread': { messages: [
    msg({ id: 'first', at: new Date(now - 30_000).toISOString(), text: 'First line' }),
    msg({ id: 'last', at: new Date(now - 10_000).toISOString(), text: 'Last line' }),
  ] },
  '/api/verse/fleet/runs': { inbox: [] },
  '/api/verse/leader/directives': { directives: [] },
  '/api/verse/agent-bus/status': status,
  '/api/verse/agent-bus': { v: 1, status: 'ok', messages, nextCursor: 110 },
});
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('draws one plain-words row per app action, in time order, and never the raw envelope', async () => {
  stubSurfaceFetch({ routes: routes([...actions, reply]) });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  const quit = await within(log).findByRole('group', { name: 'App action: Quit Slack, refused' });
  expect(quit).toHaveTextContent('that app is never available to agents.');
  expect(quit).toHaveTextContent('1.2 s');
  expect(quit).toHaveAttribute('data-tone', 'bad');
  expect(quit.querySelector('time')).toHaveAttribute('datetime', new Date(now - 23_800).toISOString());
  expect(within(log).getByRole('group', { name: 'App action: Open Figma, waiting for you' })).toHaveAttribute('data-tone', 'warn');
  expect(within(log).getByRole('group', { name: 'App action: Focus Notes, in progress' })).toHaveAttribute('data-tone', 'live');
  expect(log).not.toHaveTextContent('"kind":"apps-control"');
  // Two envelopes per finished action make one row; the app actions are not counted as bus replies.
  expect(within(log).getAllByRole('group', { name: /^App action:/ })).toHaveLength(3);
  expect(within(log).getAllByRole('region', { name: 'Bus reply' })).toHaveLength(1);
  expect(screen.getByText('1 bus replies')).toBeInTheDocument();
  expect(screen.getByText('3 app actions')).toBeInTheDocument();
  const order = [...log.querySelectorAll('section, [role="group"]')].map(node => node.textContent ?? '');
  const at = (text: string) => order.findIndex(value => value.includes(text));
  expect([at('First line'), at('Quit Slack'), at('Open Figma'), at('Last line'), at('Got it'), at('Focus Notes')]).toEqual([0, 1, 2, 3, 4, 5]);
});

it('keeps only the app actions waiting on Mason under Needs you only', async () => {
  stubSurfaceFetch({ routes: routes(actions) });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  await within(log).findByRole('group', { name: 'App action: Quit Slack, refused' });
  fireEvent.click(screen.getByRole('button', { name: 'Needs you only' }));
  expect(within(log).getAllByRole('group', { name: /^App action:/ }).map(node => node.getAttribute('aria-label'))).toEqual(['App action: Open Figma, waiting for you']);
});

it('shows no app action count and no row when the bus holds none', async () => {
  stubSurfaceFetch({ routes: routes([reply]) });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  await within(log).findByRole('region', { name: 'Bus reply' });
  expect(within(log).queryByRole('group', { name: /^App action:/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/app actions?$/)).not.toBeInTheDocument();
});

it('merges and finds app actions with the thread, leaving undated lines last', () => {
  const rows = appActionRows(actions, now);
  expect(busRepliesToMason([...actions, reply], now).map(row => row.key)).toEqual(['bus-ack-1']);
  const line = (id: string, at: number) => ({ id, at, who: 'leader' as const, source: 'verse' as const, text: id, ack: null });
  const items = mergeByTime([line('one', now - 30_000), line('two', now - 10_000), line('undated', NaN)], busRepliesToMason([reply], now), rows);
  expect(items.map(item => item.type === 'line' ? item.line.id : item.row.key))
    .toEqual(['one', 'app-apps-control-12', 'app-apps-control-14', 'two', 'bus-ack-1', 'app-apps-control-15', 'undated']);
  const find = items.map(item => item.type === 'line' ? { ...item, key: item.line.id } : { ...item, key: item.row.key });
  expect(threadMatches(find, 'figma')).toEqual(['app-apps-control-14']);
  expect(threadMatches(find, 'never available')).toEqual(['app-apps-control-12']);
  expect(threadMatches(find, 'in progress')).toEqual(['app-apps-control-15']);
});
