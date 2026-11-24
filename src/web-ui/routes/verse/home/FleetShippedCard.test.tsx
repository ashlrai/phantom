import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FleetShippedCard } from './FleetShippedCard.js';
import { evictAll } from '../../../data/cache.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });
it('shows newest shipped PRs as links from the shared feed', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json({ schema: 'fleet.shipped.v1', complete: true,
    totals: { merged: 1, mergedPerHour: 1 / 24, medianOpenToMergeSeconds: 600 },
    items: [{ repo: 'ashlrai/phantom', number: 7, title: 'Show shipped work', lane: 'codex-personal' }] }));
  vi.stubGlobal('fetch', fetch); render(<FleetShippedCard />);
  expect((await screen.findByRole('link', { name: 'phantom #7: Show shipped work' })).getAttribute('href')).toBe('https://github.com/ashlrai/phantom/pull/7');
  expect(screen.getByRole('region', { name: 'Shipped today' })).toBeTruthy();
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/verse/shipped?since=24h');
});
