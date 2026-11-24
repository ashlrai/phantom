import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { resetBusMissingForTest } from '../bus-query.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { resetFleetRunsMissingForTest } from '../runs-queries.js';
import { RunsScreen } from './RunsScreen.js';

afterEach(() => { evictAll(); resetFleetRunsMissingForTest(); resetBusMissingForTest(); vi.unstubAllGlobals(); });

it('shows capability badges on each phone lane row, unknown when unreported', async () => {
  stubFetch({
    'GET /api/verse/fleet/runs': {
      v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { workers: 'healthy' }, lastTick: "2026-10-31T11:58:00Z", paused: false, claudeLane: 'healthy',
      lanes: [
        { lane: 'claude', running: 1, target: 2, queued: 0, held: false, heldReason: null },
        { lane: 'gemini', running: 0, target: 1, queued: 0, held: false, heldReason: null },
      ],
      workers: [], leaders: [], mergesLastHour: { count: 0, items: [] }, codexPersonal: null, inbox: [], events: [],
    },
    'GET /api/fleet/lanes': { lanes: [{ lane: 'claude', caps: { gh: false, browser: true, network: true, signedIn: true } }] },
  });
  renderMobile(<RunsScreen />);
  expect(await screen.findByText('no gh')).toHaveAttribute('title', 'no gh: jobs that run gh go elsewhere.');
  expect(screen.getByRole('list', { name: 'gemini capabilities' })).toHaveTextContent('gh: unknown');
});
