import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { InterjectBox } from './InterjectBox.js';
import { PENDING_ACK_KEY } from './interject-ack-model.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');

function stub(ack: string | Error) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ at: '2026-11-01T12:00:00Z' }, { status: 201 });
    if (String(url).includes('limit=100')) {
      if (ack instanceof Error) throw ack;
      return Response.json({ inbox: [{ id: 'ack-fake-1', ack }] });
    }
    return Response.json({ inbox: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const seed = (ageMs: number) => localStorage.setItem(PENDING_ACK_KEY,
  JSON.stringify({ v: 1, id: 'ack-fake-1', sentAtMs: NOW - ageMs }));
const posts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, init]) => init?.method === 'POST').length;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  sessionStorage.clear(); localStorage.clear(); evictAll(); setMutationToken('a'.repeat(64));
});
afterEach(() => { vi.useRealTimers(); clearMutationToken(); vi.unstubAllGlobals(); });

it('resumes a pending wait at mount without sending', async () => {
  const fetcher = stub('pending');
  seed(5 * 60_000);
  await act(async () => { render(<InterjectBox />); });
  expect(screen.getByText('Sent · waiting for the planner')).toBeInTheDocument();
  expect(posts(fetcher)).toBe(0);
  expect(localStorage.getItem(PENDING_ACK_KEY)).not.toBeNull();
});

it('shows the acknowledgement at once and clears the record', async () => {
  stub('acked');
  seed(5 * 60_000);
  await act(async () => { render(<InterjectBox />); });
  expect(screen.getByText('Planner acknowledged')).toBeInTheDocument();
  expect(localStorage.getItem(PENDING_ACK_KEY)).toBeNull();
});

it('keeps waiting when the immediate check fails, and expires on the remaining time', async () => {
  stub(new Error('offline'));
  seed(19 * 60_000);
  await act(async () => { render(<InterjectBox />); });
  expect(screen.getByText('Sent · waiting for the planner')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByText('Not acknowledged yet · check the Inbox pane')).toBeInTheDocument();
  expect(localStorage.getItem(PENDING_ACK_KEY)).toBeNull();
});

it('ignores and removes a record older than 20 minutes', async () => {
  stub('acked');
  seed(21 * 60_000);
  await act(async () => { render(<InterjectBox />); });
  expect(screen.queryByText(/waiting for the planner|Planner|Not acknowledged/)).not.toBeInTheDocument();
  expect(localStorage.getItem(PENDING_ACK_KEY)).toBeNull();
});
