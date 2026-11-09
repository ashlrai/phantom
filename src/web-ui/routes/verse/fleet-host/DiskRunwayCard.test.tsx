import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { DiskRunwayCard } from './DiskRunwayCard.js';
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('renders the projected headline', async () => {
  const body = { v: 1, generatedAt: '2026-11-09T00:00:00Z', advice: 'avoid-large-writes', forecast: {
    status: 'projected', freeGb: 160, consumptionGbPerHour: 5, hoursUntilThreshold: 2, crossingAt: new Date(2026, 10, 9, 14, 30).toISOString() } };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
  render(<DiskRunwayCard visible />);
  expect(await screen.findByText('About 2 h of disk left before 150 GB (at 14:30)')).toHaveAttribute('data-tone', 'warn');
  expect(screen.getByText('160.0 GB free · 5.0 GB/h')).toBeTruthy();
});
