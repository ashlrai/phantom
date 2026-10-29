/**
 * Component test: the releases view renders fixture per-repo release status
 * (version, tag, workflow, latest release and run), keeps every row
 * read-only, and reports unavailable GitHub reads as UNKNOWN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { OpsReleases } from './OpsReleases.js';
import type { OpsReleasesV1 } from '../../../../core/verse/ops-types.js';

function fixture(over: Partial<OpsReleasesV1> = {}): OpsReleasesV1 {
  return {
    v: 1,
    generatedAt: '2026-10-30T10:05:00Z',
    repos: [
      {
        repo: 'ashlrai/phantom', path: '/repos/phantom', version: '3.16.2', latestTag: 'v3.16.2',
        releaseWorkflow: 'release.yml',
        gh: {
          latestRelease: { tag: 'v3.16.2', name: 'Phantom 3.16.2', publishedAt: '2026-10-29T08:00:00Z', draft: false, prerelease: false },
          latestRun: { workflow: 'release.yml', status: 'completed', conclusion: 'success', at: '2026-10-29T08:10:00Z' },
        },
        notes: [],
      },
      {
        repo: 'ashlrai/hub', path: '/repos/hub', version: '0.4.0', latestTag: null,
        releaseWorkflow: null,
        gh: null,
        notes: ['gh could not answer: it may be missing, unauthenticated, or offline.'],
      },
    ],
    sourceState: 'healthy',
    ...over,
  };
}

function stub(value: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)));
}

beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('OpsReleases', () => {
  it('renders fixture release rows read-only', async () => {
    stub(fixture());
    render(<OpsReleases />);
    await screen.findByText('ashlrai/phantom');
    expect(screen.getByText('v3.16.2')).toBeInTheDocument();
    expect(screen.getByText('tag v3.16.2')).toBeInTheDocument();
    expect(screen.getByText(/workflow release\.yml/)).toBeInTheDocument();
    expect(screen.getByText(/latest release v3\.16\.2/)).toBeInTheDocument();
    expect(screen.getByText(/last run success/)).toBeInTheDocument();
    // The second repo: honest UNKNOWN, no publish affordance anywhere.
    expect(screen.getByText('ashlrai/hub')).toBeInTheDocument();
    expect(screen.getByText('GitHub status unavailable', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish|deploy|release now/i })).not.toBeInTheDocument();
  });

  it('says the list may be incomplete when the enrolled read degraded', async () => {
    stub(fixture({ sourceState: 'degraded' }));
    render(<OpsReleases />);
    await screen.findByText('The enrolled-repo list could not be read, so this may be incomplete.');
  });

  it('shows the unavailable state when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'nope' }, { status: 500 })));
    render(<OpsReleases />);
    await screen.findByText('Release status is unavailable. Refresh to reconnect.');
  });
});
