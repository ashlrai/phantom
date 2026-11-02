import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

const mocks = vi.hoisted(() => ({ installed: vi.fn(() => '3.29.15' as string | null) }));
vi.mock('../sections/app-version.js', () => ({ APP_VERSION: '3.29.15', installedDesktopVersion: mocks.installed }));

const props = { visible: true } as PaneProps;
const phantomRow = (over: Record<string, unknown> = {}) => ({
  repo: 'ashlrai/phantom', path: '/phantom', version: '3.29.15', latestTag: 'v3.30.0', releaseWorkflow: 'release.yml',
  gh: { latestRelease: { tag: 'v3.30.0', name: '3.30.0', publishedAt: '2026-10-31T00:00:00Z', draft: false, prerelease: false },
    latestRun: null }, notes: [], ...over,
});
const fixture = (phantom = phantomRow()) => ({
  v: 1, generatedAt: '2026-10-31T00:00:00Z', sourceState: 'healthy',
  repos: [
    { repo: 'ashlrai/other', path: '/other', version: '9.9.9', latestTag: 'v9.9.9', releaseWorkflow: null,
      gh: { latestRelease: { tag: 'v9.9.9', name: null, publishedAt: '2026-10-31T00:00:00Z', draft: false, prerelease: false },
        latestRun: null }, notes: [] },
    phantom,
  ],
});

beforeEach(() => { evictAll(); mocks.installed.mockReturnValue('3.29.15'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stubFetch = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async (url: string) =>
  url.includes('/release-pr') ? Response.json({}, { status: 404 }) : Response.json(data)));

const rows = async () => within(await screen.findByRole('list', { name: 'Releases' })).getAllByRole('listitem');

it('marks the phantom repo behind when this Mac runs an older version', async () => {
  stubFetch(fixture());
  render(<FleetReleasesPane {...props} />);
  const items = await rows();
  expect(items[0]).toHaveTextContent('ashlrai/phantom');
  expect(items[0]).toHaveTextContent('This Mac runs v3.29.15 · latest v3.30.0 · behind by Installed 3.29.15 · latest release v3.30.0');
  const notes = within(items[0]!).getByRole('link', { name: 'Release notes' });
  expect(notes).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/releases/tag/v3.30.0');
  expect(notes).toHaveAttribute('target', '_blank');
  expect(notes).toHaveAttribute('rel', 'noopener noreferrer');
  expect(items[1]).not.toHaveTextContent('This Mac runs');
});

it('marks the phantom repo up to date when versions match', async () => {
  mocks.installed.mockReturnValue('3.30.0');
  stubFetch(fixture());
  render(<FleetReleasesPane {...props} />);
  const items = await rows();
  expect(items[0]).toHaveTextContent('This Mac runs v3.30.0 · latest v3.30.0 · up to date');
});

it('marks a newer install as a dev build ahead of the newest tag', async () => {
  mocks.installed.mockReturnValue('3.30.1');
  stubFetch(fixture());
  render(<FleetReleasesPane {...props} />);
  const items = await rows();
  expect(items[0]).toHaveTextContent('This Mac runs v3.30.1 · latest v3.30.0 · ahead of the newest tag (dev build)');
});

it('says no release yet when the phantom repo has no tag', async () => {
  stubFetch(fixture(phantomRow({ latestTag: null, gh: { latestRelease: null, latestRun: null } })));
  render(<FleetReleasesPane {...props} />);
  const items = await rows();
  expect(items[0]).toHaveTextContent('This Mac runs v3.29.15 · no release yet');
  expect(within(items[0]!).queryByRole('link', { name: 'Release notes' })).not.toBeInTheDocument();
});

it('falls back to the checkout tag when gh cannot answer', async () => {
  stubFetch(fixture(phantomRow({ gh: null })));
  render(<FleetReleasesPane {...props} />);
  const items = await rows();
  expect(items[0]).toHaveTextContent('This Mac runs v3.29.15 · latest v3.30.0 · behind');
});

it('says the installed version is unknown when the desktop bridge is absent', async () => {
  mocks.installed.mockReturnValue(null);
  stubFetch(fixture());
  render(<FleetReleasesPane {...props} />);
  const items = await rows();
  expect(items[0]).toHaveTextContent('Installed version unknown');
  expect(items[0]).not.toHaveTextContent('This Mac runs');
});
