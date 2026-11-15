import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LibraryPane } from './LibraryPane.js';

vi.mock('../command/nav.js', () => ({ openChat: vi.fn() }));
vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const status = (retainedCount: number) => ({ v: 1, source: 'available', retainedCount, retainedBytes: 10, liveCount: retainedCount, expiredCount: 0, maxMessages: 1000, maxBytes: 1_000_000 });
const message = (cursor: number, from: string, body: unknown, priority = 'P2') => ({
  cursor, receivedAt: Date.now() - 120_000, envelope: { id: `m${cursor}`, from, to: 'leader', priority, ttl: 3_600_000, body },
});
const messages = [
  message(1, 'worker-1', 'older note'),
  message(2, 'worker-2', { text: '<b>bold</b> claim' }, 'P0'),
  message(3, 'worker-3', { summary: 'finished the thing' }),
];

function stub(busStatus: Response, busPage: Response) {
  stubSurfaceFetch({ routes: {
    '/api/verse/sessions': [],
    '/api/verse/agent-bus/status': () => busStatus.clone(),
    '/api/verse/agent-bus': () => busPage.clone(),
  } });
}

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

// The "route missing" test runs last: the bus queries remember a 404 for the page lifetime.
describe('LibraryPane agent conversation', () => {
  it('lists the newest messages first as plain text', async () => {
    stub(json(status(3)), json({ v: 1, status: 'ok', messages, nextCursor: 4 }));
    const { container } = render(<LibraryPane visible />);
    const list = await screen.findByRole('list', { name: 'Recent agent messages' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('worker-3 → leader');
    expect(rows[0]).toHaveTextContent('finished the thing');
    expect(rows[0]).toHaveTextContent('2m ago');
    expect(rows[1]).toHaveTextContent('P0');
    expect(rows[0]).not.toHaveTextContent('P2');
    expect(screen.getByText('<b>bold</b> claim')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open the bus' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the Leader thread' })).toBeInTheDocument();
  });

  it('says so when the bus is empty', async () => {
    stub(json(status(0)), json({ v: 1, status: 'ok', messages: [], nextCursor: 0 }));
    render(<LibraryPane visible />);
    expect(await screen.findByText('No agent messages yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Recent agent messages' })).toBeNull();
  });

  it('shows the error sentence for any other failure', async () => {
    stub(json({ error: 'bus storage unavailable' }, 503), json({}, 503));
    render(<LibraryPane visible />);
    expect(await screen.findByText('bus storage unavailable')).toBeInTheDocument();
  });

  it('says the build has no bus when the route is missing', async () => {
    stub(json({ error: 'not found' }, 404), json({ error: 'not found' }, 404));
    render(<LibraryPane visible />);
    expect(await screen.findByText('This Phantom build has no agent bus yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the bus' })).toBeInTheDocument();
  });
});
