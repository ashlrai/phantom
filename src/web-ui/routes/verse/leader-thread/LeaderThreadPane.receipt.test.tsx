import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const base = {
  '/api/verse/leader/thread': { messages: [] },
  '/api/verse/fleet/runs': { inbox: [] },
  '/api/verse/leader/directives': { directives: [] },
};
const inbound = { seq: 1, id: 'm1', channel: 'imessage', senderId: 'imessage:+15550000000', direction: 'inbound', at: iso(now - 40_000), text: 'Fake phone text' };
const outbound = { seq: 2, id: 'm2', channel: 'imessage', senderId: 'leader', direction: 'outbound', at: iso(now - 20_000), text: 'Fake leader reply', fanout: ['imessage', 'desktop'] };
const owner = (receipts?: unknown) => ({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages: [inbound, outbound], ...(receipts ? { receipts } : {}) });

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function lines(body: unknown) {
  stubSurfaceFetch({ routes: { ...base, '/api/verse/comms/owner-thread': body } });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  await within(log).findByText('Fake leader reply');
  const [incoming, outgoing] = [...log.querySelectorAll('section')];
  return { incoming: incoming!, outgoing: outgoing! };
}

it('shows delivered and failed channels under an outgoing message only', async () => {
  const { incoming, outgoing } = await lines(owner({ m2: { desktop: { state: 'delivered' }, imessage: { state: 'failed', reason: 'not configured' } } }));
  expect(outgoing.querySelector('[data-delivery-receipt]')).toHaveTextContent('Delivered: Desktop — Failed: iMessage (not configured)');
  expect(incoming.querySelector('[data-delivery-receipt]')).toBeNull();
});

it('says unknown, never delivered, when there is no record', async () => {
  const { outgoing } = await lines(owner());
  const receipt = outgoing.querySelector('[data-delivery-receipt]')!;
  expect(receipt).toHaveTextContent('Unknown: iMessage · Desktop');
  expect(receipt).not.toHaveTextContent('Delivered');
});
