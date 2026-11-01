import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { JobDetailSheet } from './JobDetailSheet.js';

const job = 'RQ-PHX-ABC31';
const detail = { schema: 'fleet.job.v1', job, state: 'running', lane: 'codex-personal',
  log: { source: 'live', tail: ['Log line'] }, sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
const status = { v: 1, source: 'available', retainedCount: 150, retainedBytes: 1000, liveCount: 150, expiredCount: 0, maxMessages: 1000, maxBytes: 10000 };
const page = { v: 1, status: 'ok', nextCursor: 150, messages: [{ cursor: 150, receivedAt: 1_000,
  envelope: { id: 'fake-envelope', from: 'graph-coordinator', to: 'leaders', priority: 'P1', ttl: 999_999_999_9999,
    body: { kind: 'handoff', job, text: `taking ${job}` } } }] };

beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

it('shows recent matching bus envelopes between notes and the unchanged log', async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/verse/agent-bus/status') return Response.json(status);
    if (path.startsWith('/api/verse/agent-bus?')) return Response.json(page);
    return Response.json(detail);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'On the bus' });
  expect(await within(section).findByText('1 mention in the last 100 bus envelopes')).toBeInTheDocument();
  expect(within(section).getByRole('listitem')).toHaveTextContent(`graph-coordinator → leaders · handoff · taking ${job}`);
  expect(within(section).getByText(/ago/).tagName).toBe('TIME');
  expect(fetcher.mock.calls.some(([path]) => path === '/api/verse/agent-bus?after=50&limit=100')).toBe(true);
  expect(screen.getByRole('region', { name: 'Bridge notes' }).compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(section.compareDocumentPosition(screen.getByText('Log line')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}, 15_000);

it('shows a muted unavailable notice when the bus returns 503', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/verse/agent-bus/status' ? new Response(null, { status: 503 }) : Response.json(detail)));
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Durable bus unavailable.')).toHaveAttribute('role', 'status');
  expect(screen.getByText('Log line')).toBeInTheDocument();
});

it('refreshes bus reads while open and stops when closed', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (path: string) => path === '/api/verse/agent-bus/status' ? Response.json(status)
    : path.startsWith('/api/verse/agent-bus?') ? Response.json(page) : Response.json(detail));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/verse/agent-bus/status')).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([path]) => path.startsWith('/api/verse/agent-bus?'))).toHaveLength(2);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/verse/agent-bus/status')).toHaveLength(2);
});

it('shows the unavailable notice for an older hub without the bus route', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/verse/agent-bus/status' ? new Response(null, { status: 404 }) : Response.json(detail)));
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Durable bus unavailable.')).toBeInTheDocument();
});
