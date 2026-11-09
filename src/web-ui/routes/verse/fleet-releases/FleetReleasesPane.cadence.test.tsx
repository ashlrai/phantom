import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetReleasesPane } from './FleetReleasesPane.js';

vi.mock('../sections/app-version.js', () => ({ APP_VERSION: '3.29.15', installedDesktopVersion: () => '3.29.15' }));

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('warns that the release train is behind when the newest release is over two hours old', async () => {
  const data = { v: 1, generatedAt: '2026-10-31T00:00:00Z', sourceState: 'healthy', repos: [{
    repo: 'ashlrai/phantom', path: '/phantom', version: '3.30.0', latestTag: 'v3.30.0', releaseWorkflow: 'release.yml',
    gh: { latestRelease: { tag: 'v3.30.0', name: null, publishedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), draft: false, prerelease: false }, latestRun: null }, notes: [] }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/release-pr') ? Response.json({}, { status: 404 }) : Response.json(data)));
  render(<FleetReleasesPane {...{ visible: true } as PaneProps} />);
  const line = await screen.findByLabelText('Release cadence');
  expect(line).toHaveTextContent('Installed 3.29.15 · newest published 3.30.0 (behind)');
  expect(line).toHaveTextContent('Release train is behind: no release in 5h');
  expect(line).toHaveAttribute('data-tone', 'warn');
});
