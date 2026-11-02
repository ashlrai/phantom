import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { HomeRuns } from './HomeRuns.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

it('opens Live runs when a lane row is tapped', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs': {
    v: 1, lastTick: null, claudeLane: null, switches: [], codexPersonal: null,
    lanes: [
      { lane: 'claude', running: 3, target: 6, queued: 1, held: false },
      { lane: 'codex', running: 2, target: 4, queued: 0, held: true },
    ],
    mergesLastHour: { count: 0, items: [] },
  } });
  const { context } = renderMobile(<HomeRuns />);
  const claude = await screen.findByRole('button', { name: 'Open Live runs for claude' });
  expect(screen.getByRole('button', { name: 'Open Live runs for codex' })).toBeInTheDocument();
  fireEvent.click(claude);
  expect(context.navigate).toHaveBeenCalledWith({ screen: 'runs' });
});
