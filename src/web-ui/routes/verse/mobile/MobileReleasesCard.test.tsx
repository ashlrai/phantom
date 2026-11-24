import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseCadence } from '../../../../core/release/status.js';
import { evictAll } from '../../../data/cache.js';
import { MobileReleasesCard } from './MobileReleasesCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('MobileReleasesCard', () => {
  it('shows the single most overdue repo with its verdict, and opens the full list in place', async () => {
    const report = releaseCadence([
      { repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: day(1), mergedPrsSinceTag: 2 },
      { repo: 'ashlrai/locus', latestTag: 'v0.9.1', taggedAt: day(11), mergedPrsSinceTag: 62 },
    ], now);
    const stub = stubFetch({ 'GET /api/fleet/releases': json(report) });
    renderMobile(<MobileReleasesCard />);
    expect(await screen.findByText('locus: due')).toBeInTheDocument();
    expect(screen.getByText('locus: 62 PRs since v0.9.1 11 days ago; release due')).toBeInTheDocument();
    expect(screen.queryByText('phantom: fresh')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /All repos \(2\)/ }));
    expect(screen.getByText('phantom: fresh')).toBeInTheDocument();
    expect(stub.calls.map(call => call.url)).toEqual(['/api/fleet/releases']);
  });

  it('says so when nothing is due', async () => {
    stubFetch({ 'GET /api/fleet/releases': json(releaseCadence([{ repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: day(1), mergedPrsSinceTag: 2 }], now)) });
    renderMobile(<MobileReleasesCard />);
    expect(await screen.findByText('Release due: none')).toBeInTheDocument();
  });

  it('reads unknown for a reply that is not the releases report', async () => {
    stubFetch({ 'GET /api/fleet/releases': json({ error: 'not found' }) });
    renderMobile(<MobileReleasesCard />);
    expect(await screen.findByText('Releases: unknown')).toBeInTheDocument();
  });
});
