import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseRow, ReleasesV1 } from '../../../../core/release/releases-shape.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ReleasesCard } from './ReleasesCard.js';
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown, error: undefined as Error | undefined, updatedAt: null as number | null, refresh: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => state.refresh }));
const base: ReleaseRow = { repo: 'phantom', defaultBranch: 'main', latestTag: 'v1', ageDays: 1, commitsSinceTag: 0,
  published: { tag: 'v1', publishedAt: '2026-11-16T12:00:00Z', prerelease: false }, drafts: [], releasesKnown: true,
  mergedPrsSinceRelease: 0, freshness: 'fresh', reason: 'Since publication.', next: 'no new merged PRs' };
const fixture: ReleasesV1 = { schema: 'phantom.releases.v1', version: 1, asOf: '2026-11-17T12:00:00Z', repos: [base,
  { ...base, repo: 'locus', mergedPrsSinceRelease: 2, freshness: 'behind', drafts: [{ tag: 'v2', publishedAt: null, prerelease: false }], next: 'review release' },
  { ...base, repo: 'lexicon', published: null, freshness: 'unknown', mergedPrsSinceRelease: null, reason: 'No published stable release establishes a baseline.', next: 'unknown' }] };
let viewport: ViewportMock | undefined;
afterEach(() => { cleanup(); viewport?.restore(); state.refresh.mockClear(); state.status = 'success'; state.data = undefined; state.error = undefined; state.updatedAt = null; });
describe.each([390, 1440])('Releases card at %i px', width => {
  it('shows all freshness states, published and draft details with one read-only action', () => {
    viewport = mockViewport(width); state.data = fixture; render(<ReleasesCard visible />);
    const card = within(screen.getByRole('region', { name: 'Releases' }));
    expect(card.getAllByRole('listitem').map(r => r.textContent)).toEqual([expect.stringContaining('phantom: fresh.'), expect.stringContaining('locus: behind 2 merged PRs.'), expect.stringContaining('lexicon: unknown.')]);
    expect(card.getByText(/Published v1; Draft: v2/)).toBeTruthy(); expect(card.getByText(/No published stable release/)).toBeTruthy();
    expect(card.queryByRole('status')).toBeNull();
    expect(card.getAllByRole('button')).toHaveLength(1); fireEvent.click(card.getByRole('button', { name: 'Check again' })); expect(state.refresh).toHaveBeenCalledTimes(1);
  });
  it('shows a successful empty report without a stale warning', () => {
    viewport = mockViewport(width); state.data = { schema: 'phantom.releases.v1', version: 1, asOf: fixture.asOf, repos: [] }; render(<ReleasesCard visible />);
    const card = within(screen.getByRole('region', { name: 'Releases' }));
    expect(card.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Releases' }).querySelector('time')?.getAttribute('datetime')).toBe(fixture.asOf);
    expect(card.queryByRole('status')).toBeNull();
  });
  it('shows loading, malformed data and a stale cached report distinctly', () => {
    viewport = mockViewport(width); state.data = undefined; const view = render(<ReleasesCard visible />); expect(screen.getByText('Reading releases…')).toBeTruthy();
    state.data = { ...fixture, repos: [{}] }; view.rerender(<ReleasesCard visible />); expect(screen.getByText(/Unknown: the release report could not be read/)).toBeTruthy();
    const lastSuccess = Date.parse('2026-11-17T11:00:00Z');
    state.data = fixture; state.status = 'error'; state.error = new Error('HTTP 503'); state.updatedAt = lastSuccess; view.rerender(<ReleasesCard visible />);
    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain('Refresh failed; showing the last release report, which may be stale.');
    expect(warning.querySelector('time')?.getAttribute('datetime')).toBe(new Date(lastSuccess).toISOString());
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});
