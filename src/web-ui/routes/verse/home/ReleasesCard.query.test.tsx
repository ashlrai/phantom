import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReleaseRow, ReleasesV1 } from '../../../../core/release/releases-shape.js';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ReleasesCard } from './ReleasesCard.js';

const row: ReleaseRow = {
  repo: 'phantom', defaultBranch: 'main', latestTag: 'v1', ageDays: 3, commitsSinceTag: 0,
  published: { tag: 'v1', publishedAt: '2026-11-16T12:00:00.000Z', prerelease: false }, drafts: [], releasesKnown: true,
  mergedPrsSinceRelease: 0, freshness: 'fresh', reason: 'Since publication.', next: 'no new merged PRs',
};
const report: ReleasesV1 = { schema: 'phantom.releases.v1', version: 1, asOf: '2026-11-17T12:00:00.000Z', repos: [row] };
let viewport: ViewportMock | null = null;
let responses: Response[] = [];
const fetched: string[] = [];

function stubFetch(next: Response[]) {
  responses = [...next];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    const response = responses.shift();
    if (!response) throw new Error('unexpected releases request');
    return response;
  }));
}

beforeEach(() => { evictAll(); fetched.length = 0; viewport = mockViewport(1440); });
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; vi.unstubAllGlobals(); evictAll(); });

describe('ReleasesCard query refresh', () => {
  it('keeps the cached report and shows its last-success time after a 503', async () => {
    stubFetch([Response.json(report), new Response('{}', { status: 503 })]);
    render(<ReleasesCard visible />);
    expect(await screen.findByText(/phantom: fresh\./)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();

    const lastSuccess = getQuerySnapshot<ReleasesV1>('fleet-releases').updatedAt;
    expect(lastSuccess).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    const warning = await screen.findByRole('status');
    expect(warning.textContent).toContain('Refresh failed; showing the last release report, which may be stale.');
    expect(warning.querySelector('time')?.getAttribute('datetime')).toBe(new Date(lastSuccess!).toISOString());
    expect(screen.getByText(/phantom: fresh\./)).toBeTruthy();
    expect(fetched).toHaveLength(2);
    expect(fetched.every(url => url.includes('/api/verse/fleet/runs/releases'))).toBe(true);
    const cached = getQuerySnapshot<ReleasesV1>('fleet-releases');
    expect(cached.data).toEqual(report);
    expect(cached.updatedAt).toBe(lastSuccess);
  });

  it('shows an error state for a 503 when no report is cached', async () => {
    stubFetch([new Response('{}', { status: 503 })]);
    render(<ReleasesCard visible />);
    expect((await screen.findByRole('status')).textContent).toBe('Release report unavailable right now. Try again.');
    expect(screen.queryByText(/phantom: fresh\./)).toBeNull();
    expect(getQuerySnapshot<ReleasesV1>('fleet-releases').data).toBeUndefined();
  });
});
