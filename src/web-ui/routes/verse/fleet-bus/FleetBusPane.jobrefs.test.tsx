import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import type { BusFeedData } from '../fleet/bus-feed-queries.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusPane } from './FleetBusPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const data: BusFeedData = {
  v: 1, hops: [], hopsDropped: 0, lastHopAt: null, sources: { hops: 'healthy', events: 'healthy' },
  events: [
    { at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'launched RQ-PHX-RAILHONEST31 codex-bridge pid 1' },
    { at: '2026-01-02T00:00:00Z', kind: 'published', text: 'merged ashlrai/phantom #1931 bridge' },
  ],
};
beforeEach(() => { evictAll(); resetWorkerLogSelection(); vi.mocked(apiGet).mockResolvedValue(data); });
afterEach(() => { cleanup(); vi.mocked(apiGet).mockReset(); resetWorkerLogSelection(); });

it('opens the worker log for a job ref and links PR refs to GitHub', async () => {
  const openPane = vi.fn();
  render(<FleetBusPane {...{ visible: true, host: { openPane } } as unknown as PaneProps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open log for RQ-PHX-RAILHONEST31' }));
  expect(openPane).toHaveBeenCalledWith('worker-log');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-PHX-RAILHONEST31');
  expect(screen.getByRole('link', { name: '#1931' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1931');
});
