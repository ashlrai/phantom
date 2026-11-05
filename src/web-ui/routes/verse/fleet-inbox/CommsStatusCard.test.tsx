import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { EMAIL_DROP_USAGE } from '../fleet-channels/fleet-channels-model.js';
import { CommsStatusCard } from './CommsStatusCard.js';

const status = (over: Record<string, unknown> = {}) => Response.json({
  version: 1,
  generatedAt: new Date().toISOString(),
  drafts: { pending: 2, oldestPendingAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
  emailOutbox: { configured: true, queued: 1, drafted: 2, sent: 3, stuck: 1, stuckReasons: { 'interrupted-send': 1 } },
  sources: { drafts: 'healthy', emailOutbox: 'healthy' },
  ...over,
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders the drafts and email counts with the stuck reason', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => status()));
  render(<CommsStatusCard visible />);
  expect(await screen.findByText('2 drafts waiting for you (oldest 3 h)')).toBeInTheDocument();
  expect(screen.getByText(/Email replies: 1 queued · 2 drafted · 3 sent · 1 stuck/)).toBeInTheDocument();
  expect(screen.getByText('Stuck: 1 interrupted-send')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Comms' })).toBeInTheDocument();
});

it('shows the setup hint and the copyable usage line when the email drop is not configured', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => status({
    emailOutbox: { configured: false, queued: 0, drafted: 0, sent: 0, stuck: 0, stuckReasons: {} },
    sources: { drafts: 'healthy', emailOutbox: 'missing' },
    drafts: { pending: 0, oldestPendingAt: null },
  })));
  render(<CommsStatusCard visible />);
  expect(await screen.findByText('Email drop not set up')).toBeInTheDocument();
  expect(screen.getByText(EMAIL_DROP_USAGE)).toBeInTheDocument();
  expect(screen.getByText('No drafts waiting')).toBeInTheDocument();
});

it('shows "unavailable" for a null section, never a fake zero', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => status({
    drafts: null,
    sources: { drafts: 'degraded', emailOutbox: 'healthy' },
  })));
  render(<CommsStatusCard visible />);
  expect(await screen.findByText('Drafts unavailable')).toBeInTheDocument();
  expect(screen.getByText(/Email replies: 1 queued/)).toBeInTheDocument();
});

it('renders nothing when the route is not in this build', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<CommsStatusCard visible />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(view.container).toBeEmptyDOMElement();
});
