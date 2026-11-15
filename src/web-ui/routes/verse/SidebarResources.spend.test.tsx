import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { resetVerseUi } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';

// The Dot row makes its own comms-status read; this suite covers the Spend down section only.
vi.mock('./resources/DotResourceRow.js', () => ({ DotResourceRow: () => null }));

function spend(pools: unknown[]) {
  return { v: 1, asOf: '2026-11-09T16:00:00Z', pools };
}

beforeEach(() => { evictAll(); resetVerseUi(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Spend down section in the Resources sidebar', () => {
  it('shows each pool with used percent, reset, hours left, burn and projected unused', async () => {
    const { calls } = installFetch(({ path }) => path === '/api/usage/spend' ? json(spend([
      { pool: 'zai', reason: null, usedPercent: 20, resetAt: '2026-11-10T02:00:00Z', hoursLeft: 10, burnPerHour: 3, projectedUnusedPercent: 50 },
    ])) : json({}, 404));
    render(<SidebarResources />);
    expect(await screen.findByRole('region', { name: 'Spend down' })).toBeVisible();
    expect(screen.getByText('zai')).toBeVisible();
    expect(await screen.findByText(/20% used · reset .+ · 10\.0 hours left · 3% per hour · 50\.0% unused at reset/)).toBeVisible();
    expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/api/usage/spend', method: 'GET' }]);
  });

  it('reads "unknown (status unavailable)" when the read fails', async () => {
    installFetch(() => json({ error: 'unavailable' }, 503));
    render(<SidebarResources />);
    expect(await screen.findByText('unknown (status unavailable)')).toBeVisible();
  });

  it('renders the reason for pools whose reading is missing', async () => {
    installFetch(({ path }) => path === '/api/usage/spend' ? json(spend([
      { pool: 'gemini', reason: 'reading missing', usedPercent: null, resetAt: null, hoursLeft: null, burnPerHour: null, projectedUnusedPercent: null },
    ])) : json({}, 404));
    render(<SidebarResources />);
    expect(await screen.findByText('unknown (reading missing)')).toBeVisible();
    expect(screen.getByText('gemini')).toBeVisible();
  });
});
