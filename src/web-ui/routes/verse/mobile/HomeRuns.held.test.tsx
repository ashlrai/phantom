import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { HomeRuns } from './HomeRuns.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

it('shows the hold reason or today’s merge count on lane rows', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs': {
    v: 1, lastTick: null, claudeLane: null, switches: [], codexPersonal: null,
    lanes: [
      { lane: 'held', running: 2, target: 4, queued: 0, held: true, heldReason: 'usage_limit', merged24h: 5 },
      { lane: 'working', running: 1, target: 2, queued: 0, held: false, heldReason: null, merged24h: 12 },
      { lane: 'unknown', running: 1, target: 2, queued: 0, held: false, heldReason: null, merged24h: null },
    ],
    mergesLastHour: { count: 0, items: [] },
  } });
  renderMobile(<HomeRuns />);
  const held = await screen.findByRole('button', { name: 'Open Live runs for held' });
  expect(within(held).getByText('held: usage limit')).toBeInTheDocument();
  expect(within(held).queryByText('5 merged today')).not.toBeInTheDocument();
  expect(within(screen.getByRole('button', { name: 'Open Live runs for working' })).getByText('12 merged today')).toBeInTheDocument();
  const unknown = screen.getByRole('button', { name: 'Open Live runs for unknown' });
  expect(unknown).toHaveTextContent('1/2 · 0 queued');
  expect(unknown.textContent).toBe('unknown1/2 · 0 queued');
});
