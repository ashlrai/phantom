import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { fetchLeaderStatusNow } from './leader-status-now.js';

vi.mock('./leader-status-now.js', () => ({ fetchLeaderStatusNow: vi.fn() }));

beforeEach(() => {
  evictAll();
  stubSurfaceFetch({ routes: {
    '/api/verse/leader/thread': { messages: [msg({ id: 'one', text: 'Hello from the Leader.' })] },
    '/api/verse/leader/directives': { directives: [] },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('Leader status now', () => {
  it('shows and dismisses the brief', async () => {
    vi.mocked(fetchLeaderStatusNow).mockResolvedValue('First line\nSecond line');
    render(<LeaderThreadPane visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Status now' }));
    expect(await screen.findByText(/First line/)).toHaveTextContent('First line Second line');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/First line/)).not.toBeInTheDocument();
  });
  it('shows unavailable when the brief is missing', async () => {
    vi.mocked(fetchLeaderStatusNow).mockResolvedValue(null);
    render(<LeaderThreadPane visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Status now' }));
    expect(await screen.findByText('Status is unavailable right now.')).toBeInTheDocument();
  });
});
