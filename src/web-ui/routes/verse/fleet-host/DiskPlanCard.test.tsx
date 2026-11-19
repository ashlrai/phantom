import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { DiskPlanCard } from './DiskPlanCard.js';

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows the one sentence and the counts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    schema: 'disk.plan.v1', generatedAt: '2026-11-18T12:00:00.000Z',
    sentence: 'Disk: 301 GB free, falling 20 GB an hour, 10 hours to the floor; 212 finished job folders could free about 160 GB',
    runway: {}, gaps: [],
    report: { plan: { count: 212, gb: 160, folders: [] }, notSure: [{}, {}], unpublished: [{}] },
  })));
  render(<DiskPlanCard visible />);
  expect(await screen.findByText(/^Disk: 301 GB free, falling 20 GB an hour/)).toBeInTheDocument();
  expect(screen.getByText(/2 not sure, kept · 1 with unpublished work/)).toBeInTheDocument();
});
