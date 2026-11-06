import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { fleetLive } from '../../command/fixtures.test-support.js';
import { controlSnapshot } from '../../sections/section-fixtures.test-support.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { HomeBody } from './HomeBody.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('Home personal Codex usage', () => {
  it('shows the personal usage from the fleet runs snapshot', async () => {
    stubFetch({
      'GET /api/verse/control': controlSnapshot(),
      'GET /api/verse/fleet/live': fleetLive('live', Date.now()),
      'GET /api/verse/bootstrap': {},
      'GET /api/verse/fleet/runs': {
        v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [],
        mergesLastHour: { count: 0 },
        codexPersonal: { usedPct: 92, resetsAt: '2026-11-04T05:41:00Z' },
      },
      'GET /api/verse/cloud': {},
    });

    renderMobile(<HomeBody />);
    expect(await screen.findByText('Personal Codex')).toBeTruthy();
    expect(screen.getByText('92% used · resets Wed 00:41 ET')).toBeTruthy();
  });
});
