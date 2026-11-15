import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { UnifiedInboxCard } from './UnifiedInboxCard.js';

const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `bus:b-${n}`, source: 'bus', kind: 'bus-work', severity: 'info', blocking: false,
  title: `Item ${n}`, since: null, expiresAt: null, act: [], ...over,
});
const healthy = { state: 'healthy', pending: 0 };
const inbox = (items: unknown[], over: Record<string, unknown> = {}) => Response.json({
  schema: 'comms.unified-inbox.v1', total: items.length, omitted: 0,
  sources: { 'needs-you': healthy, imessage: healthy, drafts: healthy, bus: healthy, gmail: healthy },
  items, ...over,
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders the detail line and a copyable fix for an unhealthy source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => inbox([item(1, { detail: 'teammate-a · waiting 12m' })], {
    sources: { 'needs-you': healthy, imessage: healthy, drafts: healthy, bus: healthy, gmail: { state: 'missing', pending: 0 } },
  })));
  render(<UnifiedInboxCard visible />);
  expect(await screen.findByText('teammate-a · waiting 12m')).toBeInTheDocument();
  expect(screen.getByText(/Gmail: not set up on this Mac/)).toBeInTheDocument();
  expect(screen.getByText('phm fleet gmail-archive-plan')).toBeInTheDocument();
});

it('expands to every item with Show all and collapses with Show fewer', async () => {
  const items = Array.from({ length: 12 }, (_, i) => item(i + 1));
  const fetchMock = vi.fn(async (url: unknown) => String(url).includes('limit=200') ? inbox(items) : inbox(items.slice(0, 10), { total: 12, omitted: 2 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<UnifiedInboxCard visible />);
  expect(await screen.findByText('Item 1')).toBeInTheDocument();
  expect(screen.queryByText('Item 12')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show all (12)' }));
  expect(await screen.findByText('Item 12')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
  await vi.waitFor(() => expect(screen.queryByText('Item 12')).toBeNull());
  expect(screen.getByRole('button', { name: 'Show all (12)' })).toBeInTheDocument();
});
