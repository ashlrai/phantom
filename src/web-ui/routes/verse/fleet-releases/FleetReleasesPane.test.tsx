import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

const props = { visible: true } as PaneProps;
const fixture = () => ({
  v: 1, generatedAt: '2026-01-01T00:00:00Z', sourceState: 'healthy',
  repos: [
    { repo: 'ashlrai/other', path: '/other', version: null, latestTag: null, releaseWorkflow: null,
      gh: { latestRelease: null, latestRun: null }, notes: ['No release found'] },
    { repo: 'ashlrai/phantom', path: '/phantom', version: '1.2.3', latestTag: 'v1.2.3', releaseWorkflow: 'release.yml',
      gh: { latestRelease: { tag: 'v1.2.3', name: 'New release', publishedAt: '2026-01-01T00:00:00Z', draft: false, prerelease: true },
        latestRun: { workflow: 'Release', status: 'completed', conclusion: 'success', at: '2026-01-01T00:00:00Z' } }, notes: [] },
  ],
});
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders release data for each repo, with Phantom first', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetReleasesPane {...props} />);
  const list = within(await screen.findByRole('list', { name: 'Releases' }));
  const rows = list.getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('ashlrai/phantom');
  expect(rows[0]).toHaveTextContent('Version: 1.2.3 · Tag: v1.2.3');
  expect(rows[0]).toHaveTextContent('Release: v1.2.3 · New release prerelease');
  expect(rows[0]).toHaveTextContent('Run: Release · completed/success ·');
  expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/releases');
  expect(within(rows[0]).getByRole('link')).toHaveAttribute('target', '_blank');
  expect(within(rows[0]).getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  expect(rows[1]).toHaveTextContent('Version: — · Tag: —');
  expect(rows[1]).toHaveTextContent('No release found');
  expect(screen.getByText(/2 repos · read /)).toBeInTheDocument();
});

it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetReleasesPane {...props} />);
  expect(await screen.findByText('Releases not in this build')).toBeInTheDocument();
});

it('reports an incomplete source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fixture(), sourceState: 'degraded' })));
  render(<FleetReleasesPane {...props} />);
  expect(await screen.findByText('Release data may be incomplete.')).toBeInTheDocument();
});

it('reports an offline GitHub probe', async () => {
  const data = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, repos: [{ ...data.repos[0], gh: null }] })));
  render(<FleetReleasesPane {...props} />);
  expect(await screen.findByText('GitHub status unknown (gh offline)')).toBeInTheDocument();
});

it('reports an unavailable initial reading', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));
  render(<FleetReleasesPane {...props} />);
  expect(await screen.findByText('Releases are unavailable.')).toBeInTheDocument();
});

it('shows errors and preserves the last reading on a failed refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetReleasesPane {...props} />);
  await screen.findByRole('list', { name: 'Releases' });
  await act(async () => { await refetchQuery('verse-ops-releases', async () => { throw new Error('offline'); }, true); });
  expect(screen.getByText('Releases could not refresh. Showing the last reading.')).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Releases' })).toBeInTheDocument();
});

it('polls only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetReleasesPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetReleasesPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetReleasesPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
