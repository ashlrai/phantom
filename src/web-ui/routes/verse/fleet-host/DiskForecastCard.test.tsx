import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { diskForecast } from '../../../../core/fleet/disk-forecast.js';
import { evictAll } from '../../../data/cache.js';
import { DiskForecastCard } from './DiskForecastCard.js';

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('renders the projected line', async () => {
  const forecast = { ...diskForecast(null, null), status: 'projected', hoursUntilThreshold: 9, consumptionGbPerHour: 4.2, crossingAt: '2026-11-10T03:10:00Z' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ v: 1, forecast })));
  render(<DiskForecastCard visible />);
  expect(await screen.findByText(/Free disk reaches 150 GB in about 9 h .* at 4.2 GB\/h/)).toHaveAttribute('data-tone', 'warn');
});
it('renders nothing for a missing route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  const { container } = render(<DiskForecastCard visible />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
