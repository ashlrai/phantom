import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { GmailArchivePlanCard } from './GmailArchivePlanCard.js';

const SCHEMA = 'fleet.gmail-archive-plan-latest.v1';
const plan = (over: Record<string, unknown> = {}) => ({
  inbox: 'inbox-a', at: new Date(Date.now() - 3 * 60_000).toISOString(), unread: 140, target: 100, archiveCount: 40,
  topSenders: [{ sender: 'sender@example.com', count: 25 }, { sender: 'news@example.com', count: 10 }], ...over,
});
const serve = (latest: unknown) => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: SCHEMA, latest })));

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders counts, senders, age and the nothing-is-deleted line per inbox', async () => {
  serve({ schema: SCHEMA, plans: [plan(), plan({ inbox: 'inbox-b', unread: 12, archiveCount: 0, topSenders: [] })] });
  render(<GmailArchivePlanCard visible />);
  expect(await screen.findByText('140 unread (source unknown) (target 100) · would archive 40')).toBeInTheDocument();
  expect(screen.getByText('12 unread (source unknown) (target 100) · would archive 0')).toBeInTheDocument();
  expect(screen.getByText('Top senders: sender@example.com (25), news@example.com (10)')).toBeInTheDocument();
  expect(screen.getByText('inbox-a')).toBeInTheDocument();
  expect(screen.getAllByText(/3m ago/)).toHaveLength(2);
  expect(screen.queryByText(/stale/)).toBeNull();
  expect(screen.getByText('Archive only, nothing is deleted.')).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});

it('shows the empty state with the command', async () => {
  serve(null);
  render(<GmailArchivePlanCard visible />);
  expect(await screen.findByText(/No archive plan yet\. Run/)).toBeInTheDocument();
  expect(screen.getByText('ashlr fleet gmail-archive-plan')).toBeInTheDocument();
});

it('marks a plan older than 24 hours as stale', async () => {
  serve({ schema: SCHEMA, plans: [plan({ at: new Date(Date.now() - 25 * 3_600_000).toISOString() })] });
  render(<GmailArchivePlanCard visible />);
  expect(await screen.findByText(/1d ago · stale/)).toBeInTheDocument();
});

it('renders nothing on a malformed payload or server error', async () => {
  for (const response of [Response.json({ schema: 'other', latest: null }), new Response('boom', { status: 500 })]) {
    evictAll();
    const fetchMock = vi.fn(async () => response.clone());
    vi.stubGlobal('fetch', fetchMock);
    const { container, unmount } = render(<GmailArchivePlanCard visible />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    unmount();
  }
});
