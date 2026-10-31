import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { opsQueueQuery } from '../ops/ops-queue-queries.js';
import { json, renderMobile } from './mobile.test-support.js';
import { QueueSection } from './QueueSection.js';

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 7, ready: 2, parked: 5, malformed: 0, skipsLast24h: 1,
  byLane: [{ lane: 'codex', ready: 2, parked: 5 }],
  groups: [{ reason: 'BYHAND', lane: 'codex', count: 5, jobs: ['job-a', 'job-b', 'job-c', 'job-d', 'job-e'] }],
  skips: [{ at: '2026-10-31T11:00:00Z', job: 'job-skip', code: '13', reason: 'files already exist' }],
};

function stubQueue(response: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return url.split('?')[0] === '/api/verse/fleet/live/queue' ? response() : json({ error: 'not found' }, 404);
  }));
}

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('QueueSection', () => {
  it('shows counts by lane, parked jobs and the latest precheck skip', async () => {
    stubQueue(() => json(queue));
    renderMobile(<QueueSection />);
    const section = await screen.findByRole('region', { name: 'Queue' });
    expect(await within(section).findByText('2 ready · 5 parked · 1 skips/24 h')).toBeInTheDocument();
    expect(within(section).getByText('codex', { exact: true })).toBeInTheDocument();
    expect(within(section).getByText('Parked by hand')).toBeInTheDocument();
    expect(within(section).getByText(/job-a, job-b, job-c, job-d/)).toHaveTextContent('+1 more');
    expect(within(section).getByText('job-skip · 13 · files already exist')).toBeInTheDocument();
    expect(within(section).getByText(/^Updated /)).toBeInTheDocument();
  });

  it('shows when the endpoint is absent', async () => {
    stubQueue(() => json({ error: 'not found' }, 404));
    renderMobile(<QueueSection />);
    expect(await screen.findByText('Queue not in this build')).toBeInTheDocument();
  });

  it('warns when either source is incomplete', async () => {
    stubQueue(() => json({ ...queue, sources: { ready: 'healthy', skips: 'degraded' } }));
    renderMobile(<QueueSection />);
    expect(await screen.findByText('Queue data may be incomplete.')).toBeInTheDocument();
  });

  it('shows an error and retries when the first read fails', async () => {
    let failed = true;
    stubQueue(() => failed ? json({ error: 'Queue is offline' }, 500) : json(queue));
    renderMobile(<QueueSection />);
    expect(await screen.findByText('Queue is offline')).toBeInTheDocument();
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Parked by hand')).toBeInTheDocument();
  });

  it('keeps the last reading and warns when a refresh fails', async () => {
    let failed = false;
    stubQueue(() => failed ? json({ error: 'Queue is offline' }, 500) : json(queue));
    renderMobile(<QueueSection />);
    await screen.findByText('Parked by hand');
    failed = true;
    await refetchQuery(opsQueueQuery.key, () => opsQueueQuery.fetch(), true);
    await waitFor(() => expect(screen.getByText('Queue could not refresh. Showing the last reading.')).toBeInTheDocument());
    expect(screen.getByText('Parked by hand')).toBeInTheDocument();
  });
});
