import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { FleetScreen } from './FleetScreen.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

it('shows a stalled merge gate when publishes are not merging', async () => {
  stubFetch({
    'GET /api/verse/fleet/runs': {
      v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], codexPersonal: null,
      mergesLastHour: { count: 0, items: [] }, publishesLastHour: Array(4).fill({}),
    },
  });
  renderMobile(<FleetScreen />);
  const section = await screen.findByRole('region', { name: 'Merges' });
  const row = within(section).getByText('0 merged, 4 published in the last hour — merge gate stalled');
  expect(row.closest('[data-tone]')).toHaveAttribute('data-tone', 'danger');
});
