import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LeaderConversation } from '../leader/LeaderConversation.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

vi.mock('../leader/LeaderConversation.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../leader/LeaderConversation.js')>();
  return { ...actual, LeaderConversation: vi.fn(actual.LeaderConversation) };
});

function serve() {
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [
      msg({ id: 'one', from: 'mason', text: 'What is slowing merges?' }),
      msg({ id: 'two', text: 'The judge queue is busy.' }),
    ] },
    '/api/verse/leader/directives': { directives: [] },
  } });
}

beforeEach(() => { evictAll(); clearMutationToken(); vi.mocked(LeaderConversation).mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('LeaderThreadPane', () => {
  it('renders the shared conversation and leader thread', async () => {
    serve();
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('What is slowing merges?')).toBeInTheDocument();
    expect(await within(log).findByText('The judge queue is busy.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message the Leader' })).toBeInTheDocument();
  });

  it('adds a directive through the existing leader route', async () => {
    const net = serve();
    setMutationToken('a'.repeat(64));
    render(<LeaderThreadPane visible />);
    const strip = screen.getByRole('group', { name: 'Directives' });
    await within(strip).findByRole('button', { name: /Add directive/ });
    fireEvent.click(within(strip).getByRole('button', { name: /Add directive/ }));
    const input = within(strip).getByRole('textbox', { name: 'New directive' });
    fireEvent.change(input, { target: { value: 'Keep the queue moving' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(net.posted).toContainEqual({ url: '/api/verse/leader/directives', body: { text: 'Keep the queue moving' } }));
  });

  it('polls while visible, then passes dormant and stops reads while hidden', async () => {
    vi.useFakeTimers();
    const net = serve();
    const view = render(<LeaderThreadPane visible />);
    await act(async () => {});
    const initialLeaderReads = net.fetchMock.mock.calls.filter(([url]) => url === '/api/verse/leader').length;
    expect(initialLeaderReads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(net.fetchMock.mock.calls.filter(([url]) => url === '/api/verse/leader')).toHaveLength(2);
    view.rerender(<LeaderThreadPane visible={false} />);
    expect(vi.mocked(LeaderConversation).mock.lastCall?.[0].dormant).toBe(true);
    const calls = net.fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(net.fetchMock).toHaveBeenCalledTimes(calls);
    view.rerender(<LeaderThreadPane visible />);
    await act(async () => {});
    expect(vi.mocked(LeaderConversation).mock.lastCall?.[0].dormant).toBe(false);
    expect(net.fetchMock.mock.calls.filter(([url]) => url === '/api/verse/leader')).toHaveLength(3);
  });
});
