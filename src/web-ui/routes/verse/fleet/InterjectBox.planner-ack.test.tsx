import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';

const ackReads = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.filter(([url]) => String(url) === '/api/verse/fleet/runs/inbox?limit=100').length;

function stub(post: unknown, acks: Array<string | Error> = []) {
  const queue = [...acks];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json(post, { status: 201 });
    if (String(url).includes('limit=100')) {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return Response.json({ inbox: [{ id: 'e1', ack: next }, { id: 'other', ack: 'acked' }] });
    }
    return Response.json({ inbox: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function send() {
  const view = render(<InterjectBox />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  return view;
}

beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { vi.useRealTimers(); clearMutationToken(); vi.unstubAllGlobals(); });

it('waits, then shows the acknowledgement and stops polling', async () => {
  const fetcher = stub({ at: '2026-10-31T12:00:00Z', id: 'e1' }, ['pending', 'acked']);
  await send();
  expect(screen.getByText('Sent · waiting for the planner')).toHaveAttribute('role', 'status');
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(ackReads(fetcher)).toBe(1);
  expect(screen.getByText('Sent · waiting for the planner')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(screen.getByText('Planner acknowledged')).toBeInTheDocument();
  const reads = ackReads(fetcher);
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(ackReads(fetcher)).toBe(reads);
});

it('shows the no-reply-route text when the planner skipped it', async () => {
  stub({ at: '2026-10-31T12:00:00Z', id: 'e1' }, ['skipped']);
  await send();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(screen.getByText('Planner saw it · no reply route')).toBeInTheDocument();
});

it('keeps waiting silently when a poll fails', async () => {
  const fetcher = stub({ at: '2026-10-31T12:00:00Z', id: 'e1' }, [new Error('offline'), 'acked']);
  await send();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(screen.getByText('Sent · waiting for the planner')).toBeInTheDocument();
  expect(screen.queryByText('offline')).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(screen.getByText('Planner acknowledged')).toBeInTheDocument();
  expect(ackReads(fetcher)).toBe(2);
});

it('shows no waiting line when the POST returned no id', async () => {
  const fetcher = stub({ at: '2026-10-31T12:00:00Z' }, ['acked']);
  await send();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.queryByText(/waiting for the planner/)).not.toBeInTheDocument();
  expect(ackReads(fetcher)).toBe(0);
});

it('gives up after 20 minutes', async () => {
  stub({ at: '2026-10-31T12:00:00Z', id: 'e1' }, ['pending']);
  await send();
  await act(() => vi.advanceTimersByTimeAsync(20 * 60_000));
  expect(screen.getByText('Not acknowledged yet · check the Inbox pane')).toBeInTheDocument();
});

it('clears the timer on unmount', async () => {
  const fetcher = stub({ at: '2026-10-31T12:00:00Z', id: 'e1' }, ['pending']);
  const view = await send();
  view.unmount();
  const before = ackReads(fetcher);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(ackReads(fetcher)).toBe(before);
});
