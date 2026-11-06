import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { MobileReleaseCard } from './MobileReleaseCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

const release = { v: 1, generatedAt: '2026-11-01T12:00:00Z', sourceState: 'healthy', repos: [{ repo: 'example/phantom', path: '/fixture', pr: null, notes: [] }] };
const runUrl = 'https://github.com/example/phantom/actions/runs/1';
const facts = { v: 1, available: true, daily: { runId: 1, conclusion: 'failure', createdAt: '2026-11-01T06:00:00Z', failedJobs: ['build', 'test'], url: runUrl } };

beforeEach(() => { evictAll(); vi.setSystemTime(new Date('2026-11-01T12:00:00Z')); });
afterEach(() => { cleanup(); evictAll(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the failed daily run and its link below the release row', async () => {
  stubFetch({ 'GET /api/verse/release-pr': release, 'GET /api/verse/fleet/ci-runs': facts });
  renderMobile(<MobileReleaseCard />);
  expect(await screen.findByText('No release PR open')).toBeInTheDocument();
  const verdict = await screen.findByText('Daily CI red, ran 6 h ago · Failing: build, test');
  expect(verdict.parentElement).toHaveAttribute('data-tone', 'bad');
  expect(screen.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', runUrl);
});

it('shows only the release row when CI is unavailable', async () => {
  stubFetch({ 'GET /api/verse/release-pr': release, 'GET /api/verse/fleet/ci-runs': json({}, 404) });
  renderMobile(<MobileReleaseCard />);
  expect(await screen.findByText('No release PR open')).toBeInTheDocument();
  await waitFor(() => expect(getQuerySnapshot('verse-fleet-ci-runs-48').status).toBe('success'));
  expect(screen.queryByText(/Daily CI/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Open run' })).not.toBeInTheDocument();
});
