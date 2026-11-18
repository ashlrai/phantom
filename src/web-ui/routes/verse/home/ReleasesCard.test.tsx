import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseRow, ReleasesV1 } from '../../../../core/release/releases-shape.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ReleasesCard } from './ReleasesCard.js';
const state = vi.hoisted(() => ({ status: 'success', data: undefined as unknown, refresh: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => state.refresh }));
const base: ReleaseRow = { repo: 'phantom', defaultBranch: 'main', latestTag: 'v1', ageDays: 1, commitsSinceTag: 0,
  published: { tag: 'v1', publishedAt: '2026-11-16T12:00:00Z', prerelease: false }, drafts: [], releasesKnown: true,
  mergedPrsSinceRelease: 0, freshness: 'fresh', reason: 'Since publication.', next: 'no new merged PRs' };
const fixture: ReleasesV1 = { schema: 'phantom.releases.v1', version: 1, asOf: '2026-11-17T12:00:00Z', repos: [base,
  { ...base, repo: 'locus', mergedPrsSinceRelease: 2, freshness: 'behind', drafts: [{ tag: 'v2', publishedAt: null, prerelease: false }], next: 'review release' },
  { ...base, repo: 'lexicon', published: null, freshness: 'unknown', mergedPrsSinceRelease: null, reason: 'No published stable release establishes a baseline.', next: 'unknown' }] };
let viewport: ViewportMock | undefined;
afterEach(() => { cleanup(); viewport?.restore(); state.refresh.mockClear(); state.status = 'success'; });
describe.each([390, 1440])('Releases card at %i px', width => {
  it('shows all freshness states, published and draft details with one read-only action', () => {
    viewport = mockViewport(width); state.data = fixture; render(<ReleasesCard visible />);
    const card = within(screen.getByRole('region', { name: 'Releases' }));
    expect(card.getAllByRole('listitem').map(r => r.textContent)).toEqual([expect.stringContaining('phantom: fresh.'), expect.stringContaining('locus: behind 2 merged PRs.'), expect.stringContaining('lexicon: unknown.')]);
    expect(card.getByText(/Published v1; Draft: v2/)).toBeTruthy(); expect(card.getByText(/No published stable release/)).toBeTruthy();
    expect(card.getAllByRole('button')).toHaveLength(1); fireEvent.click(card.getByRole('button', { name: 'Check again' })); expect(state.refresh).toHaveBeenCalledTimes(1);
  });
  it('shows loading and unknown for malformed responses or a failed refresh, even with old data', () => {
    viewport = mockViewport(width); state.data = undefined; const view = render(<ReleasesCard visible />); expect(screen.getByText('Reading releases…')).toBeTruthy();
    state.data = { ...fixture, repos: [{}] }; view.rerender(<ReleasesCard visible />); expect(screen.getByText(/Unknown: the release report could not be read/)).toBeTruthy();
    state.data = fixture; state.status = 'error'; view.rerender(<ReleasesCard visible />); expect(screen.getByText(/could not be refreshed/)).toBeTruthy(); expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
