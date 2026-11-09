import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { UnifiedInboxCard } from './UnifiedInboxCard.js';

const item = (over: Record<string, unknown> = {}) => ({
  id: 'drafts:d-test1', source: 'drafts', kind: 'draft-approval', severity: 'warn', blocking: true,
  title: 'Reply to +15550000000', since: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: null,
  act: ['phm comms drafts show d-test1'], ...over,
});
const healthy = { state: 'healthy', pending: 0 };
const inbox = (over: Record<string, unknown> = {}) => Response.json({
  schema: 'comms.unified-inbox.v1', generatedAt: new Date().toISOString(), total: 1, omitted: 0,
  sources: { 'needs-you': healthy, imessage: healthy, drafts: { state: 'healthy', pending: 1 }, bus: healthy },
  items: [item()], ...over,
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders titles, the blocking tag, the first act command and +N more', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => inbox({ total: 5, items: [item(), item({ id: 'bus:b-test2', source: 'bus', title: 'Second', blocking: false, act: [] })] })));
  render(<UnifiedInboxCard visible />);
  expect(await screen.findByText('Reply to +15550000000')).toBeInTheDocument();
  expect(screen.getByText('Second')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Waiting' })).toBeInTheDocument();
  expect(screen.getByText('blocking')).toBeInTheDocument();
  expect(screen.getByText('phm comms drafts show d-test1')).toBeInTheDocument();
  expect(screen.getByText('phm comms inbox')).toBeInTheDocument();
  expect(screen.getByText('+3 more')).toBeInTheDocument();
  expect(screen.getByText('Draft')).toBeInTheDocument();
});

it('shows the empty state when nothing waits and every source is healthy', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => inbox({ total: 0, items: [] })));
  render(<UnifiedInboxCard visible />);
  expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
});

it('shows one muted line when unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: 'comms.unified-inbox.v1', unavailable: true, items: [] })));
  render(<UnifiedInboxCard visible />);
  expect(await screen.findByText('Unified inbox unavailable')).toBeInTheDocument();
});

it('renders nothing on a fetch error', async () => {
  const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<UnifiedInboxCard visible />);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise(r => setTimeout(r, 20));
  expect(container).toBeEmptyDOMElement();
});

it('renders markup in a title as literal text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => inbox({ items: [item({ title: '<b>x</b>' })] })));
  const { container } = render(<UnifiedInboxCard visible />);
  expect(await screen.findByText('<b>x</b>')).toBeInTheDocument();
  expect(container.querySelector('b')).toBeNull();
});
