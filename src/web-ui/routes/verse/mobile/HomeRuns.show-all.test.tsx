import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { HomeRuns } from './HomeRuns.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

const mergesFixture = (n: number) => ({
  v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], codexPersonal: null,
  mergesLastHour: {
    count: n,
    items: Array.from({ length: n }, (_, i) => ({ repo: 'ashlrai/phantom', number: 2000 + i, title: `Merge ${i}` })),
  },
});

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('HomeRuns show-all', () => {
  it('caps merges at 6 and expands to show every merge', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': mergesFixture(9) });
    renderMobile(<HomeRuns />);

    const toggle = await screen.findByRole('button', { name: 'Show all 9 merges' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(screen.getByRole('link', { name: '#2000 · Merge 0' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '#2006 · Merge 6' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getAllByRole('link')).toHaveLength(9);
    expect(screen.getByRole('link', { name: '#2008 · Merge 8' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('hides the show-all button when six or fewer merges are listed', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': mergesFixture(6) });
    renderMobile(<HomeRuns />);
    expect(await screen.findAllByRole('link')).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /Show all|Show fewer/ })).not.toBeInTheDocument();
  });
});
