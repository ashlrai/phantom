import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { ReleaseGapRow } from './ReleaseGapRow.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('./app-version.js', () => ({ APP_VERSION: '3.29.15', installedDesktopVersion: () => '3.29.15' }));

const repo = {
  repo: 'ashlrai/phantom', path: '/fake', version: '3.29.15', latestTag: 'v3.99.0',
  releaseWorkflow: null, notes: [], gh: {
    latestRelease: { tag: 'v3.30.0', name: null, publishedAt: null, draft: false, prerelease: false },
    latestRun: null,
  },
};
const response = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [
  { ...repo, repo: 'another/phantom', gh: { ...repo.gh, latestRelease: { ...repo.gh.latestRelease, tag: 'v9.0.0' } } }, repo,
] };

beforeEach(() => evictAll());
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows the published release, links to its notes, and opens the Releases pane', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
  render(<ReleaseGapRow />);
  expect(await screen.findByText('Installed 3.29.15 · latest release v3.30.0')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/releases/tag/v3.30.0');
  expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('rel', 'noreferrer');
  fireEvent.click(screen.getByRole('button', { name: 'Open Releases pane' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-releases');
});

it('shows unavailable when the release read fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
  render(<ReleaseGapRow />);
  expect(await screen.findByText('Release list unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Release notes' })).not.toBeInTheDocument();
});

it('does not present a stale release after a failed refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
  render(<ReleaseGapRow />);
  await screen.findByText('Installed 3.29.15 · latest release v3.30.0');
  await act(async () => { await refetchQuery('verse-ops-releases', async () => { throw new Error('offline'); }, true); });
  expect(screen.getByText('Release list unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Release notes' })).not.toBeInTheDocument();
});

it('reads only while the section is visible', async () => {
  const fetch = vi.fn(async () => Response.json(response));
  vi.stubGlobal('fetch', fetch);
  const view = render(<SectionVisibilityProvider visible={false}><ReleaseGapRow /></SectionVisibilityProvider>);
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(<SectionVisibilityProvider visible><ReleaseGapRow /></SectionVisibilityProvider>);
  await screen.findByText('Installed 3.29.15 · latest release v3.30.0');
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});
