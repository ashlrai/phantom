import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

const releases = { v: 1, generatedAt: '2026-11-01T12:00:00Z', sourceState: 'healthy', repos: [
  { repo: 'ashlrai/phantom', path: '/fake', version: '1.0.0', latestTag: 'v1.0.0', releaseWorkflow: null, gh: null, notes: [] },
] };
const daily = { v: 1, available: true, daily: { runId: 1, conclusion: 'failure', createdAt: '2026-11-01T06:00:00Z', failedJobs: ['Mac exhaustive', 'ci'], url: 'https://github.com/ashlrai/phantom/actions/runs/1' } };

beforeEach(() => { evictAll(); vi.setSystemTime(new Date('2026-11-01T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders the linked daily result and failing jobs below the release PR', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/ci-runs')) return Response.json(daily);
    if (url.includes('/release-pr')) return Response.json({ v: 1, generatedAt: releases.generatedAt, sourceState: 'healthy', repos: [{ repo: 'ashlrai/phantom', path: '/fake', notes: [], pr: null }] });
    return Response.json(releases);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetReleasesPane {...{ visible: true } as PaneProps} />);
  const link = await screen.findByRole('link', { name: 'Daily CI red, ran 6 h ago' });
  expect(link).toHaveAttribute('href', daily.daily.url);
  expect(link.parentElement).toHaveAttribute('data-tone', 'danger');
  const row = within(screen.getByRole('list', { name: 'Releases' })).getByRole('listitem');
  expect(row).toHaveTextContent('No release PR openDaily CI red, ran 6 h agoFailing: Mac exhaustive, ci');
  expect(fetcher.mock.calls.some(([url]) => url === '/api/verse/fleet/ci-runs?hours=48')).toBe(true);
});

it.each(['404', 'network error'])('silently omits the daily row on %s', async (failure) => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/ci-runs')) {
      if (failure === 'network error') throw new Error('offline');
      return Response.json({}, { status: 404 });
    }
    if (url.includes('/release-pr')) return Response.json({}, { status: 404 });
    return Response.json(releases);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetReleasesPane {...{ visible: true } as PaneProps} />);
  await screen.findByRole('list', { name: 'Releases' });
  await waitFor(() => expect(getQuerySnapshot('verse-fleet-ci-runs-48').status).toBe('success'));
  expect(screen.queryByText(/Daily CI/)).not.toBeInTheDocument();
  expect(screen.queryByText(/CI facts not available yet/)).not.toBeInTheDocument();
});
