import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { leaderState } from '../../command/fixtures.test-support.js';
import { msg } from '../../leader/thread-fixtures.test-support.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { LeaderScreen } from './LeaderScreen.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

const base = {
  'GET /api/verse/leader/thread': { messages: [msg({ id: 'first', at: '2026-11-09T11:00:00Z', text: 'Earlier note' })] },
  'GET /api/verse/leader/directives': { directives: [], retired: [] },
  'GET /api/verse/leader': leaderState('live'),
  'GET /api/verse/fleet/runs': { v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], mergesLastHour: { count: null }, codexPersonal: null, sources: { inbox: 'healthy' }, inbox: [] },
};
const owner = (extra: Record<string, unknown> = {}) => ({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages: [
  { seq: 1, id: 'o1', channel: 'imessage', senderId: 'mason-test', direction: 'inbound', at: '2026-11-09T11:10:00Z', text: 'Synthetic hello <b>x</b>' },
  { seq: 2, id: 'o2', channel: 'desktop', senderId: 'leader', direction: 'outbound', at: '2026-11-09T11:20:00Z', text: 'Synthetic reply', fanout: ['slack', 'desktop'] },
], ...extra });

it('shows owner lines with channel labels, in time order, as plain text', async () => {
  stubFetch({ ...base, 'GET /api/verse/comms/owner-thread': owner() });
  renderMobile(<LeaderScreen />);
  const hello = await screen.findByText('Synthetic hello <b>x</b>');
  expect(hello.querySelector('b')).toBeNull();
  expect(screen.getByText('Mason via iMessage')).toBeInTheDocument();
  const reply = screen.getByText('Synthetic reply');
  expect(screen.getByText('Leader → Slack, Desktop')).toBeInTheDocument();
  expect(screen.getByText('Earlier note').compareDocumentPosition(hello) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(hello.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('leaves the thread as it was on a 404', async () => {
  stubFetch(base);
  renderMobile(<LeaderScreen />);
  expect(await screen.findByText('Earlier note')).toBeInTheDocument();
  expect(screen.queryByText(/owner/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/via /)).not.toBeInTheDocument();
});

it('says the owner channels are paused and shows no owner text', async () => {
  stubFetch({ ...base, 'GET /api/verse/comms/owner-thread': owner({ status: { kill: true } }) });
  renderMobile(<LeaderScreen />);
  expect(await screen.findByText('Owner channels are paused')).toBeInTheDocument();
  expect(screen.queryByText('Synthetic reply')).not.toBeInTheDocument();
  expect(screen.queryByText(/Synthetic hello/)).not.toBeInTheDocument();
});
