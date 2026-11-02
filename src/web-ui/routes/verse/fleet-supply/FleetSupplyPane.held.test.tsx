/**
 * routes/verse/fleet-supply/FleetSupplyPane.held.test.tsx — a held lane's
 * badge shows the local back-time and countdown, keeping the raw server
 * reason on the title attribute.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';

const now = Date.parse('2026-10-31T15:00:00Z');
const reason = 'out of usage until 2026-11-01 05:22';
const fixture = () => ({
  lanes: [{ lane: 'cmp', running: 0, target: 4, queued: 0, held: true, heldReason: reason }],
  workers: [],
  drop: { pending: [], done: 0 },
  sources: { runsDir: 'healthy' },
});

const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows when a held lane comes back and keeps the raw reason on the title', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url.includes('/fleet/runs') ? Response.json(fixture()) : Response.json({}, { status: 404 })));
  render(<FleetSupplyPane {...props} />);
  const badge = await screen.findByText(/back Nov 1 01:22 ET, in 14 h/);
  expect(badge).toHaveAttribute('title', reason);
});
