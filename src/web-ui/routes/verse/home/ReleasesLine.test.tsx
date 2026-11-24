/** The one release line on the Leader card and the phone Home: due with numbers, all fresh, or unknown. */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseCadence } from '../../../../core/release/status.js';
import { evictAll } from '../../../data/cache.js';
import { json, renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { ReleasesLine } from './ReleasesLine.js';

const now = Date.now();
const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
const PATH = 'GET /api/fleet/releases';
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

describe('ReleasesLine', () => {
  it('names the repo with the biggest backlog', async () => {
    stubFetch({ [PATH]: json(releaseCadence([
      { repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: day(1), mergedPrsSinceTag: 2 },
      { repo: 'ashlrai/locus', latestTag: 'v1.4.0', taggedAt: day(9), mergedPrsSinceTag: 23 },
    ], now)) });
    renderMobile(<ReleasesLine />);
    const line = await screen.findByText('Release due: locus (23 PRs since v1.4.0, 9 days)');
    expect(line).toHaveAttribute('data-tone', 'amber');
  });
  it('says all fresh when nothing is due', async () => {
    stubFetch({ [PATH]: json(releaseCadence([{ repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: day(1), mergedPrsSinceTag: 2 }], now)) });
    renderMobile(<ReleasesLine />);
    expect(await screen.findByText('Releases: all fresh')).toHaveAttribute('data-tone', 'ok');
  });
  it('reads unknown when the Mac does not answer', async () => {
    stubFetch({ [PATH]: json({ error: 'no' }, 503) });
    renderMobile(<ReleasesLine />);
    expect(await screen.findByText('Releases: unknown')).toHaveAttribute('data-tone', 'unknown');
  });
});
