/**
 * work-result-form-340.test.tsx — RQ-PHX-WORKRESULTFORM340. The Record result
 * action on Fleet Board work rows. apiPost and the mutation token are mocked.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBoardPane } from './FleetBoardPane.js';

const apiPost = vi.fn();
vi.mock('../../../data/client.js', async (orig) => ({ ...(await orig<typeof import('../../../data/client.js')>()), apiPost: (...a: unknown[]) => apiPost(...a) }));
vi.mock('../../../data/auth-store.js', async (orig) => ({ ...(await orig<typeof import('../../../data/auth-store.js')>()), getMutationToken: () => 'fake-token' }));
const { ApiError } = await import('../../../data/client.js');

const PROPS = { visible: true } as PaneProps;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const item = (id: string, state: string) => ({ id, channel: 'telegram', channelRef: 'r', receivedAt: ago(60_000), state, asOf: ago(0), source: 'bus', missing: [] });

let boardFetches = 0;
beforeEach(() => {
  apiPost.mockReset(); boardFetches = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/verse/fleet/work-board')) {
      boardFetches += 1;
      return new Response(JSON.stringify({ items: [item('req-fake-1', 'RUNNING'), item('req-fake-2', 'VERIFIED')], inbox: 'ok', truncated: false, asOf: ago(0) }), { status: 200 });
    }
    return new Response(JSON.stringify({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

async function openForm() {
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('req-fake-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Record result' }));
  fireEvent.change(screen.getByLabelText('Tests run'), { target: { value: '3 passed' } });
}

it('only the RUNNING row has the button', async () => {
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('req-fake-1')).toBeInTheDocument());
  expect(screen.getAllByRole('button', { name: 'Record result' })).toHaveLength(1);
  const verified = screen.getByText('req-fake-2').closest('tr') as HTMLElement;
  expect(within(verified).queryByRole('button')).toBeNull();
});

it('submits a tests result per contract and refetches', async () => {
  apiPost.mockResolvedValue({ outcome: 'posted' });
  await openForm();
  const before = boardFetches;
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Recorded (posted)'));
  const [path, body, token] = apiPost.mock.calls[0] as [string, any, string];
  expect(path).toBe('/api/verse/fleet/work-board/result');
  expect(token).toBe('fake-token');
  expect(body).toEqual({ requestId: 'req-fake-1', replyId: expect.stringMatching(/^desk-/), result: { tests: '3 passed' } });
  await waitFor(() => expect(boardFetches).toBeGreaterThan(before));
});

it('shows duplicate outcome', async () => {
  apiPost.mockResolvedValue({ outcome: 'duplicate' });
  await openForm();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Already recorded (duplicate)'));
});

it('retry after 503 reuses the same replyId', async () => {
  apiPost.mockRejectedValueOnce(new ApiError('x', 503, '/p')).mockResolvedValueOnce({ outcome: 'posted' });
  await openForm();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unavailable/));
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
  expect(apiPost.mock.calls[1]![1].replyId).toBe(apiPost.mock.calls[0]![1].replyId);
});

it('404 says not on this build', async () => {
  apiPost.mockRejectedValue(new ApiError('x', 404, '/p'));
  await openForm();
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Request not found, or this Phantom build cannot record results yet'));
});

it('invalid input never posts', async () => {
  render(<FleetBoardPane {...PROPS} />);
  await waitFor(() => expect(screen.getByText('req-fake-1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Record result' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Describe the tests');
  expect(apiPost).not.toHaveBeenCalled();
});
