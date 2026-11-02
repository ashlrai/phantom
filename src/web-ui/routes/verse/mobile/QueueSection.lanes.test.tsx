import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { json, renderMobile } from './mobile.test-support.js';
import { QueueSection } from './QueueSection.js';

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 10, ready: 3, parked: 7, malformed: 0, skipsLast24h: 0,
  byLane: [
    { lane: 'codex-personal', ready: 0, parked: 7 },
    { lane: 'claude', ready: 3, parked: 0 },
  ],
  groups: [{ reason: 'BYHAND', lane: 'codex-personal', count: 2, jobs: ['job-one', 'job-two'] }],
  skips: [],
};

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('QueueSection lane taps', () => {
  it('opens the runs screen when a lane row is tapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(queue)));
    const { context } = renderMobile(<QueueSection />);
    const lanes = await screen.findByLabelText('Queue by lane');
    const row = within(lanes).getByRole('button', { name: 'Open lane codex-personal controls' });
    expect(row).toHaveTextContent('0 ready · 7 parked');
    fireEvent.click(row);
    expect(context.navigate).toHaveBeenCalledTimes(1);
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'runs' });
    fireEvent.click(within(lanes).getByRole('button', { name: 'Open lane claude controls' }));
    expect(context.navigate).toHaveBeenNthCalledWith(2, { screen: 'runs' });
  });

  it('still opens the worker screen from parked group jobs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(queue)));
    const { context } = renderMobile(<QueueSection />);
    const groups = await screen.findByLabelText('Parked groups');
    fireEvent.click(within(groups).getByRole('button', { name: 'Open worker job-one' }));
    expect(context.navigate).toHaveBeenCalledTimes(1);
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'worker', job: 'job-one' });
  });
});
