import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusPane } from './FleetBusPane.js';

const row = { cursor: 1, receivedAt: 1_700_000_000_000, envelope: { id: 'fake-agent-1', from: 'graph-coordinator', to: 'leaders', priority: 'P1', ttl: 604_800_000, body: { text: 'Please check this' } } };
const status = { v: 1, source: 'available', retainedCount: 1, retainedBytes: 10, liveCount: 1, expiredCount: 0, maxMessages: 100, maxBytes: 10000 };
const dispatch = { v: 1, hops: [], hopsDropped: 0, lastHopAt: null, events: [], sources: { hops: 'healthy', events: 'healthy' } };
let messages: unknown[];
let posts: unknown[];
beforeEach(() => {
  evictAll(); setMutationToken('a'.repeat(64)); messages = [row]; posts = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const envelope = JSON.parse(String(init.body)); posts.push(envelope);
      messages.push({ cursor: 2, receivedAt: Date.now(), envelope });
      return Response.json({ v: 1, status: 'posted', cursor: 2 }, { status: 201 });
    }
    if (path.includes('/fleet/live/bus')) return Response.json(dispatch);
    if (path.endsWith('/status')) return Response.json({ ...status, retainedCount: messages.length });
    return Response.json({ v: 1, status: 'ok', messages, nextCursor: messages.length });
  }));
});
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it('replies to a sender and refreshes the posted envelope', async () => {
  render(<FleetBusPane {...({ visible: true } as PaneProps)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Durable bus' }));
  const list = await screen.findByRole('list', { name: 'Durable bus envelopes' });
  fireEvent.click(within(list).getByRole('button', { name: 'Reply' }));
  const message = screen.getByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(message).toHaveFocus());
  expect(screen.getByRole('combobox', { name: 'To' })).toHaveValue('graph-coordinator');
  fireEvent.change(message, { target: { value: 'On it' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/Posted/);
  expect(posts).toEqual([expect.objectContaining({ to: 'graph-coordinator', body: expect.objectContaining({ text: 'On it', replyTo: 'fake-agent-1' }) })]);
  await waitFor(() => expect(within(list).getByText('On it')).toBeInTheDocument());
  expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/status')).length).toBeGreaterThanOrEqual(2);
});
