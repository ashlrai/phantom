import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { HomeRuns } from './HomeRuns.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

it('links valid merges and keeps invalid repositories as plain rows', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs': {
    v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], codexPersonal: null,
    mergesLastHour: { count: 2, items: [
      { repo: 'ashlrai/phantom', number: 1811, title: 'First merge' },
      { repo: 'invalid', number: 2, title: 'Second merge' },
    ] },
  } });
  renderMobile(<HomeRuns />);
  const link = await screen.findByRole('link', { name: '#1811 · First merge' });
  expect(link).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1811');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText('#2 · Second merge').closest('a')).toBeNull();
  expect(screen.getAllByRole('link')).toHaveLength(1);
});
