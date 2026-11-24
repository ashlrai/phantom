import { render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { releaseCadence } from '../../../../core/release/status.js';
import { CADENCE_REPOS } from '../../../../core/release/cadence.js';
import { evictAll } from '../../../data/cache.js';
import { ReleasesCard } from './ReleasesCard.js';
import { MobileReleasesCard } from '../mobile/MobileReleasesCard.js';
import { json, renderMobile, stubFetch } from '../mobile/mobile.test-support.js';

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
it.each(['desktop', 'phone'])('shows all seven commit rows and reasons immediately on %s', async surface => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const report = { ...releaseCadence([], now), releaseRepos: CADENCE_REPOS.map((repo, i) => ({
    repo, latestTag: i === 6 ? null : 'v3.30.71', tagDate: new Date(now - 7_200_000).toISOString(),
    commitsSinceTag: i === 6 ? null : 14, state: i === 6 ? 'unknown' as const : 'ok' as const,
    reason: i === 6 ? 'Local: no local clone; remote: remote tags unavailable.' : 'Release cadence is current.',
  })) };
  stubFetch({ 'GET /api/fleet/releases': json(report) });
  if (surface === 'desktop') render(<ReleasesCard report={report} />); else renderMobile(<MobileReleasesCard />);
  const rows = within(await screen.findByRole('list', { name: 'Release cadence' }));
  expect(rows.getAllByRole('listitem')).toHaveLength(7);
  expect(rows.getByText('phantom: v3.30.71, 2 hours ago, 14 commits waiting')).toBeInTheDocument();
  expect(rows.getByText('ashlr-md: unknown')).toBeInTheDocument();
  expect(rows.getByText(/Local: no local clone; remote: remote tags unavailable/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /All repos/ })).toBeNull();
});
