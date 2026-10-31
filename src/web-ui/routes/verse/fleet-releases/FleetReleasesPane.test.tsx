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
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(4);
  view.rerender(<FleetReleasesPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

const prFixture = () => ({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [
  { repo: 'AshlrAI/Phantom', path: '/fixture', notes: ['Fixture note'], pr: {
    number: 1479, title: 'chore(master): release 3.30.0', version: '3.30.0',
    url: 'https://github.com/ashlrai/phantom/pull/1479', openedAt: '2026-10-28T12:00:00Z',
    updatedAt: '2026-10-31T12:00:00Z', mergeable: 'UNKNOWN', blocked: true, pending: 0,
    failing: ['Dependency audit (root + Raycast)'], summary: '3.30.0 blocked by Dependency audit (root + Raycast)',
    checks: [{ name: 'Dependency audit (root + Raycast)', state: 'fail', url: 'https://github.com/ashlrai/phantom/actions/runs/1' }],
  } },
] });

it('shows the blocked release PR and links its failing check', async () => {
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/release-pr') ? prFixture() : fixture())));
  render(<FleetReleasesPane {...props} />);
  const headline = await screen.findByRole('link', { name: /Release PR #1479 chore\(master\): release 3.30.0/ });
  expect(headline).toHaveTextContent('3.30.0 blocked by Dependency audit (root + Raycast) · open since 3d ago');
  expect(headline).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1479');
  expect(screen.getByRole('link', { name: 'Dependency audit (root + Raycast) · fail' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/actions/runs/1');
  expect(screen.getByText('Fixture note')).toBeInTheDocument();
});

it('reports a missing PR and preserves its notes', async () => {
  const data = prFixture();
  const repos = data.repos.map(repo => ({ ...repo, pr: null }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/release-pr') ? { ...data, repos } : fixture())));
  render(<FleetReleasesPane {...props} />);
  expect(await screen.findByText('No release PR open')).toBeInTheDocument();
  expect(screen.getByText('Fixture note')).toBeInTheDocument();
});

it('keeps tags visible when the release PR read fails or is unsupported', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/release-pr') ? Response.json({}, { status: 500 }) : Response.json(fixture())));
  const view = render(<FleetReleasesPane {...props} />);
  expect(await screen.findByText('Release PR state is unavailable.')).toBeInTheDocument();
  expect(screen.getByText('Version: 1.2.3 · Tag: v1.2.3')).toBeInTheDocument();
  view.unmount();
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/release-pr') ? Response.json({}, { status: 404 }) : Response.json(fixture())));
  render(<FleetReleasesPane {...props} />);
  expect(await screen.findByText('Version: 1.2.3 · Tag: v1.2.3')).toBeInTheDocument();
  expect(screen.queryByText('Release PR state is unavailable.')).not.toBeInTheDocument();
});
