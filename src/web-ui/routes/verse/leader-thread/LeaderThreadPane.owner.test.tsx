import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const base = {
  '/api/verse/leader/thread': { messages: [msg({ id: 'first', at: iso(now - 60_000), text: 'Earlier note' })] },
  '/api/verse/fleet/runs': { inbox: [] },
  '/api/verse/leader/directives': { directives: [] },
};
const owner = (extra: Record<string, unknown> = {}) => ({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages: [
  { seq: 1, id: 'o1', channel: 'imessage', senderId: 'imessage:+15555550100', direction: 'inbound', at: iso(now - 40_000), text: 'Fake phone text' },
  { seq: 2, id: 'o2', channel: 'desktop', senderId: 'leader', direction: 'outbound', at: iso(now - 20_000), text: 'Fake leader reply', fanout: ['imessage'] },
], ...extra });
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows owner messages in time order with channel badges', async () => {
  stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': owner() } });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  await within(log).findByText('Fake leader reply');
  expect([...log.querySelectorAll('section')].map(n => n.textContent)).toEqual([
    expect.stringContaining('Earlier note'), expect.stringContaining('Fake phone text'), expect.stringContaining('Fake leader reply'),
  ]);
  const [phone, reply] = [...log.querySelectorAll('section')].slice(1);
  expect(phone).toHaveTextContent('Mason via iMessage');
  expect(phone!.querySelector('[data-channel="imessage"]')).toHaveTextContent('iMessage');
  expect(reply).toHaveTextContent('Leader → iMessage');
});

it('renders as before, with no error text, on a 404', async () => {
  stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': null } });
  render(<LeaderThreadPane visible />);
  expect(await screen.findByText('Earlier note')).toBeInTheDocument();
  expect(screen.queryByText(/owner/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('says "Owner channels paused" and shows no owner lines when killed', async () => {
  stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': owner({ status: { kill: true, paused: false } }) } });
  render(<LeaderThreadPane visible />);
  expect(await screen.findByText('Owner channels paused')).toBeInTheDocument();
  expect(screen.queryByText('Fake phone text')).not.toBeInTheDocument();
});
