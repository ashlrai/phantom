import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { resetBusMissingForTest } from '../bus-query.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { resetFleetRunsMissingForTest } from '../runs-queries.js';
import { RunsScreen } from './RunsScreen.js';

afterEach(() => {
  evictAll();
  resetFleetRunsMissingForTest();
  resetBusMissingForTest();
  vi.unstubAllGlobals();
});

it('opens valid workers and leaves invalid job ids read-only', async () => {
  const job = 'RQ-PHX-MOBILERUNSWORKERTAP31';
  stubFetch({ 'GET /api/verse/fleet/runs': {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { workers: 'healthy' },
    lastTick: '2026-10-31T11:58:00Z',
    paused: false,
    claudeLane: 'healthy',
    lanes: [],
    workers: [job, 'bad id!'].map((id) => ({ job: id, repo: 'example/repo', lane: 'claude', tier: 'elite', ageSeconds: 300 })),
    leaders: [],
    mergesLastHour: { count: 0, items: [] },
    codexPersonal: null,
    inbox: [],
    events: [],
  } });
  const navigate = vi.fn();
  renderMobile(<RunsScreen />, { navigate });

  fireEvent.click(await screen.findByRole('button', { name: `Open worker ${job}` }));
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ screen: 'worker', job });
  fireEvent.click(screen.getByText('bad id!'));
  expect(navigate).toHaveBeenCalledTimes(1);
});
