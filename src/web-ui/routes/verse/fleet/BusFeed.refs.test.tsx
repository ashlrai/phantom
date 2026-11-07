import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { BusFeed } from './BusFeed.js';
import type { BusFeedData } from './bus-feed-queries.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const fixture: BusFeedData = {
  v: 1,
  hops: [{ id: 'h', from: 'RQ-PHX-EXAMPLE31', to: 'leader', inputTokens: 1, outputTokens: 2 }],
  hopsDropped: 0,
  lastHopAt: '2026-10-31T12:00:00Z',
  events: [
    { at: '2026-10-31T12:01:00Z', kind: 'published', text: 'Merged #1964' },
    { at: '2026-10-31T12:02:00Z', kind: 'other', text: 'Nothing to link here' },
    { at: '2026-10-31T12:03:00Z', kind: 'other', text: 'RQ-PHX-EVENT31 finished' },
  ],
  sources: { hops: 'healthy', events: 'healthy' },
};

beforeEach(() => {
  evictAll();
  vi.clearAllMocks();
  stubSurfaceFetch({ routes: { '/api/verse/fleet/live/bus': fixture } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Agent bus references', () => {
  it('opens the worker log for a job in a hop or event', async () => {
    render(<BusFeed now={Date.parse('2026-10-31T12:04:00Z')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE31' }));
    expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-EXAMPLE31');
    expect(openDockPane).toHaveBeenCalledWith('worker-log');
    fireEvent.click(screen.getByRole('button', { name: 'Open log for RQ-PHX-EVENT31' }));
    expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-EVENT31');
    expect(openDockPane).toHaveBeenCalledTimes(2);
  });

  it('links pull requests and leaves ordinary text unchanged', async () => {
    render(<BusFeed now={Date.parse('2026-10-31T12:04:00Z')} />);
    expect(await screen.findByRole('link', { name: '#1964' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1964');
    expect(screen.getByText('Nothing to link here')).toHaveAttribute('title', 'Nothing to link here');
  });
});
