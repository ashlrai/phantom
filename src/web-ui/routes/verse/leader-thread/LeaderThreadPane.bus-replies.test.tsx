import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const now = Date.now();
const status = { v: 1, source: 'available', retainedCount: 110, retainedBytes: 1, liveCount: 110, expiredCount: 0, maxMessages: 1024, maxBytes: 1048576 };
const receipt = (id: string, to: string) => ({ cursor: 11, receivedAt: now - 20_000,
  envelope: { id, from: 'claude-leader', to, priority: 'P2', ttl: 100_000, body: { kind: 'ack', text: `Got it ${id}` } } });
const routes = {
  '/api/verse/leader/thread': { messages: [
    msg({ id: 'first', at: new Date(now - 30_000).toISOString(), text: 'First line' }),
    msg({ id: 'last', at: new Date(now - 10_000).toISOString(), text: 'Last line' }),
  ] },
  '/api/verse/fleet/runs': { inbox: [] },
  '/api/verse/leader/directives': { directives: [] },
};
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('interleaves Mason’s replies, hides other recipients and requests the newest page', async () => {
  const net = stubSurfaceFetch({ routes: { ...routes, '/api/verse/agent-bus/status': status,
    '/api/verse/agent-bus': { v: 1, status: 'ok', messages: [receipt('one', 'mason'), receipt('two', 'leader')], nextCursor: 110 } } });
  render(<LeaderThreadPane visible />);
  const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
  const bus = await within(log).findByRole('region', { name: 'Bus reply' });
  expect(bus).toHaveTextContent('claude-leader');
  expect(bus).toHaveTextContent('Via bus');
  expect(bus).toHaveTextContent('ack');
  expect(bus).toHaveTextContent('Got it one');
  expect(bus.querySelector('time')).toHaveAttribute('datetime', new Date(now - 20_000).toISOString());
  expect(within(log).queryByText('Got it two')).not.toBeInTheDocument();
  expect([...log.querySelectorAll('section')].map(node => node.textContent)).toEqual([
    expect.stringContaining('First line'), expect.stringContaining('Got it one'), expect.stringContaining('Last line'),
  ]);
  expect(screen.getByText('1 bus replies')).toBeInTheDocument();
  expect(net.fetchMock.mock.calls.some(([url]) => String(url).includes('after=10&limit=100'))).toBe(true);
});

it('keeps the thread visible and shows one notice when the bus returns 503', async () => {
  stubSurfaceFetch({ routes: { ...routes, '/api/verse/agent-bus/status': () => new Response('{}', { status: 503 }) } });
  render(<LeaderThreadPane visible />);
  expect(await screen.findByText('First line')).toBeInTheDocument();
  expect(await screen.findAllByText('Durable bus unavailable')).toHaveLength(1);
  expect(screen.getByText('Last line')).toBeInTheDocument();
});

it('polls both bus reads only while visible', async () => {
  vi.useFakeTimers();
  const net = stubSurfaceFetch({ routes: { ...routes, '/api/verse/agent-bus/status': status,
    '/api/verse/agent-bus': { v: 1, status: 'ok', messages: [], nextCursor: 110 } } });
  const view = render(<LeaderThreadPane visible />);
  await act(async () => {});
  const reads = () => net.fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/verse/agent-bus')).length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads()).toBe(4);
  view.rerender(<LeaderThreadPane visible={false} />);
  const count = reads();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(reads()).toBe(count);
});
