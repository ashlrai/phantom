import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusPane } from './FleetBusPane.js';

const now = Date.now();
const row = (id: string, cursor: number, from: string, text: string, replyTo?: string) => ({
  cursor, receivedAt: now + cursor * 1000,
  envelope: { id, from, to: 'all', priority: 'P2', ttl: 100000, body: { text, replyTo } },
});
const messages = [row('root', 1, 'mason', 'Root post'), row('reply', 2, 'leader-sol', 'First answer', 'root'),
  row('nested', 3, 'agent', 'Nested answer', 'reply'), row('second', 4, 'agent', 'Second answer', 'root'),
  row('alone', 5, 'mason', 'Unanswered post'), row('orphan', 6, 'agent', 'Missing parent', 'outside')];
const status = { v: 1, source: 'available', retainedCount: 6, retainedBytes: 10, liveCount: 6, expiredCount: 0, maxMessages: 100, maxBytes: 10000 };
const dispatch = { v: 1, hops: [], hopsDropped: 0, lastHopAt: null, events: [], sources: { hops: 'healthy', events: 'healthy' } };
let posts: unknown[];
beforeEach(() => {
  evictAll(); setMutationToken('a'.repeat(64)); posts = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ v: 1, status: 'posted', cursor: 7 }, { status: 201 });
    }
    if (path.includes('/fleet/live/bus')) return Response.json(dispatch);
    if (path.endsWith('/status')) return Response.json(status);
    return Response.json({ v: 1, status: 'ok', messages, nextCursor: 6 });
  }));
});
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it('opens a reply’s whole thread in order, replies on it, and returns to the durable feed', async () => {
  render(<FleetBusPane {...({ visible: true } as PaneProps)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Durable bus' }));
  const list = await screen.findByRole('list', { name: 'Durable bus envelopes' });
  const root = within(list).getByText('Root post').closest('li')!;
  expect(within(root).getByText('Replies: 2')).toBeInTheDocument();
  expect(within(within(list).getByText('Unanswered post').closest('li')!).queryByText(/Replies:/)).not.toBeInTheDocument();
  fireEvent.click(within(list).getByRole('button', { name: 'Open thread nested' }));
  expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    expect.stringContaining('Root post'), expect.stringContaining('First answer'),
    expect.stringContaining('Nested answer'), expect.stringContaining('Second answer'),
  ]);
  expect(screen.getByText(/Thread · 4 messages · last reply from agent/)).toBeInTheDocument();
  fireEvent.click(within(within(list).getByText('First answer').closest('li')!).getByRole('button', { name: 'Reply' }));
  expect(await screen.findByText('Replying to: First answer')).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('leader-sol');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Acknowledged' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(posts).toEqual([expect.objectContaining({ to: 'leader-sol', body: expect.objectContaining({ replyTo: 'reply' }) })]));
  fireEvent.click(screen.getByRole('button', { name: 'Back to all' }));
  expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getByRole('button', { name: 'Durable bus' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(within(list).getByRole('button', { name: 'Open thread orphan' }));
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  expect(within(list).getByText('Missing parent')).toBeVisible();
});
