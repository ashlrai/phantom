import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { ReleaseGapRow } from './ReleaseGapRow.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('./app-version.js', () => ({ APP_VERSION: '3.29.15', installedDesktopVersion: () => '3.29.15' }));

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows unshipped commits and the blocked release PR, and opens Releases', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/verse/ops/releases') return Response.json({
      v: 1, generatedAt: '2026-10-31T00:00:00Z', sourceState: 'healthy', repos: [{
        repo: 'ashlrai/phantom', path: '/fixture', version: null, latestTag: 'v3.29.15',
        releaseWorkflow: null, notes: [], commitsSinceTag: 877,
        gh: { latestRelease: { tag: 'v3.29.15', name: null, publishedAt: null, draft: false, prerelease: false }, latestRun: null },
      }],
    });
    if (url === '/api/verse/release-pr') return Response.json({
      v: 1, generatedAt: '2026-10-31T00:00:00Z', sourceState: 'healthy', repos: [{
        repo: 'ashlrai/phantom', path: '/fixture', notes: [], pr: {
          number: 1479, title: 'Release', url: 'https://example.invalid/pr/1479', version: '3.30.0',
          openedAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z', mergeable: null,
          checks: [], failing: [], pending: 0, blocked: true, summary: 'Blocked',
        },
      }],
    });
    return new Response('', { status: 404 });
  }));
  render(<ReleaseGapRow />);
  expect(await screen.findByText(/877 commits merged since, not yet released · release PR #1479 blocked/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Open Releases pane' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-releases');
});
