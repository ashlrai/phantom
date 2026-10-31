import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { ReleasePr, ReleasePrData, ReleasePrResult } from '../fleet/release-pr-query.js';
import { MobileReleaseCard, releaseLine } from './MobileReleaseCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

const FAKE_PR_URL = 'https://github.com/example/phantom/pull/2222';

function pr(partial: Partial<ReleasePr> = {}): ReleasePr {
  return {
    number: 2222, title: 'chore(master): release 3.30.0', url: FAKE_PR_URL, version: '3.30.0',
    openedAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z', mergeable: 'UNKNOWN',
    checks: [], failing: [], pending: 0, blocked: false, summary: '3.30.0 green, waiting for merge',
    ...partial,
  };
}

function releaseData(pr_: ReleasePr | null, repo = 'example/phantom'): ReleasePrData {
  return {
    v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy',
    repos: [{ repo, path: '/fixture/phantom', pr: pr_, notes: [] }],
  };
}

function release(pr_: ReleasePr | null, repo = 'example/phantom'): ReleasePrResult {
  return { kind: 'available', data: releaseData(pr_, repo) };
}

const blocked = () => pr({
  blocked: true, failing: ['Dependency audit (root + Raycast)'],
  summary: '3.30.0 blocked by Dependency audit (root + Raycast)',
  checks: [{ name: 'Dependency audit (root + Raycast)', state: 'fail', url: 'https://github.com/example/phantom/actions/runs/1' }],
});

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('releaseLine', () => {
  it('renders nothing when this build has no release read', () => {
    expect(releaseLine({ kind: 'notInBuild' })).toBeNull();
  });

  it('reports no open release PR', () => {
    expect(releaseLine(release(null))).toBe('No release PR open');
    expect(releaseLine(release(pr(), 'example/other'))).toBe('No release PR open');
  });

  it('names the failing checks when the PR is blocked', () => {
    expect(releaseLine(release(blocked()))).toBe('v3.30.0 candidate · PR #2222 · blocked: Dependency audit (root + Raycast)');
  });

  it('counts pending checks', () => {
    expect(releaseLine(release(pr({ pending: 2 })))).toBe('v3.30.0 candidate · PR #2222 · 2 checks pending');
  });

  it('calls a green PR ready to merge', () => {
    expect(releaseLine(release(pr()))).toBe('v3.30.0 candidate · PR #2222 · ready to merge');
  });

  it('writes "Release candidate" when the version is unknown', () => {
    expect(releaseLine(release(pr({ version: null })))).toBe('Release candidate · PR #2222 · ready to merge');
  });
});

describe('MobileReleaseCard', () => {
  it('shows the blocked line and the summary, with an Open PR link', async () => {
    const stub = stubFetch({ 'GET /api/verse/release-pr': releaseData(blocked()) });
    renderMobile(<MobileReleaseCard />);
    expect(await screen.findByText('v3.30.0 candidate · PR #2222 · blocked: Dependency audit (root + Raycast)')).toBeInTheDocument();
    expect(screen.getByText('3.30.0 blocked by Dependency audit (root + Raycast)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', FAKE_PR_URL);
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/verse/release-pr']);
  });

  it('renders nothing when the route answers 404', async () => {
    const stub = stubFetch({ 'GET /api/verse/release-pr': json({ error: 'not found' }, 404) });
    const { container } = renderMobile(<MobileReleaseCard />);
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows the failure reason when the read errors', async () => {
    stubFetch({ 'GET /api/verse/release-pr': json({ error: 'release probe offline' }, 500) });
    renderMobile(<MobileReleaseCard />);
    expect(await screen.findByText('Release state unavailable')).toBeInTheDocument();
    expect(screen.getByText('release probe offline')).toBeInTheDocument();
  });

  it('never links a host that is not github.com', async () => {
    stubFetch({ 'GET /api/verse/release-pr': releaseData(pr({ url: 'https://evil.example/pull/2222' })) });
    renderMobile(<MobileReleaseCard />);
    expect(await screen.findByText('v3.30.0 candidate · PR #2222 · ready to merge')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open PR' })).not.toBeInTheDocument();
  });
});
