import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { json, renderMobile } from './mobile.test-support.js';
import { QueueSection } from './QueueSection.js';

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 5, ready: 0, parked: 5, malformed: 0, skipsLast24h: 2,
  byLane: [],
  groups: [{ reason: 'BYHAND', lane: 'codex', count: 5, jobs: ['job-one', 'job-two', 'bad/job'] }],
  skips: [
    { at: '2026-10-31T11:00:00Z', job: 'job-skip', code: '13', reason: 'already exists' },
    { at: '2026-10-31T10:00:00Z', job: 'bad/skip', code: '13', reason: 'already exists' },
  ],
};

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('QueueSection job taps', () => {
  it('opens valid worker IDs and leaves invalid IDs as text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(queue)));
    const parentClick = vi.fn();
    const { context } = renderMobile(<div onClick={parentClick}><QueueSection /></div>);
    const groups = await screen.findByLabelText('Parked groups');
    const first = within(groups).getByRole('button', { name: 'Open worker job-one' });
    const second = within(groups).getByRole('button', { name: 'Open worker job-two' });
    expect(within(groups).getByText(/bad\/job/)).toBeInTheDocument();
    expect(within(groups).queryByRole('button', { name: /bad\/job/ })).not.toBeInTheDocument();
    expect(groups).toHaveTextContent('· +2 more');
    fireEvent.click(first);
    fireEvent.click(second);
    expect(context.navigate).toHaveBeenNthCalledWith(1, { screen: 'worker', job: 'job-one' });
    expect(context.navigate).toHaveBeenNthCalledWith(2, { screen: 'worker', job: 'job-two' });
    expect(parentClick).not.toHaveBeenCalled();

    const skips = screen.getByLabelText('Latest precheck skips');
    fireEvent.click(within(skips).getByRole('button', { name: /job-skip · 13/ }));
    expect(context.navigate).toHaveBeenNthCalledWith(3, { screen: 'worker', job: 'job-skip' });
    const invalidSkip = within(skips).getByText('bad/skip · 13 · already exists').closest('div');
    expect(invalidSkip?.tagName).toBe('DIV');
    expect(invalidSkip?.querySelector('svg')).toBeNull();
    expect(within(skips).queryByRole('button', { name: /bad\/skip/ })).not.toBeInTheDocument();
  });
});
