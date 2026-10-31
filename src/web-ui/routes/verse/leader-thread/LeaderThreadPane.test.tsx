import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

function serve() {
  return stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [
      msg({ id: 'one', from: 'mason', text: 'What is slowing merges?' }),
      msg({ id: 'two', text: 'The judge queue is busy.' }),
    ] },
    '/api/verse/fleet/runs': { inbox: [] },
    '/api/verse/leader/directives': { directives: [] },
  } });
}

beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearMutationToken(); });

describe('LeaderThreadPane', () => {
  it('renders the shared conversation and leader thread', async () => {
    serve();
    render(<LeaderThreadPane visible />);
    const log = screen.getByRole('log', { name: 'Conversation with the Leader' });
    expect(await within(log).findByText('What is slowing merges?')).toBeInTheDocument();
    expect(await within(log).findByText('The judge queue is busy.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply to the Leader' })).toBeInTheDocument();
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

  it('polls while visible and stops reads while hidden', async () => {
    vi.useFakeTimers();
    const net = serve();
    const view = render(<LeaderThreadPane visible />);
    await act(async () => {});
    const reads = (url: string) => net.fetchMock.mock.calls.filter(([u]) => String(u).startsWith(url)).length;
    expect(reads('/api/verse/leader/thread')).toBe(1);
    expect(reads('/api/verse/fleet/runs')).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(reads('/api/verse/leader/thread')).toBe(2);
    expect(reads('/api/verse/fleet/runs')).toBe(2);
    view.rerender(<LeaderThreadPane visible={false} />);
    const calls = net.fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(net.fetchMock).toHaveBeenCalledTimes(calls);
    view.rerender(<LeaderThreadPane visible />);
    await act(async () => {});
    expect(reads('/api/verse/leader/thread')).toBeGreaterThan(2);
    expect(reads('/api/verse/fleet/runs')).toBeGreaterThan(2);
  });
});
