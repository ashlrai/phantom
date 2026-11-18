import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASES_SCHEMA, summarizeReleases, type ReleaseRowV1, type ReleasesV1 } from '../../../../core/release/releases-shape.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ReleasesCard } from './ReleasesCard.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown }, refetch: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => state.refetch }));
const ok = <T,>(value: T) => ({ state: 'ok' as const, value });
const gone = { state: 'unknown' as const, reason: 'No local checkout of ashlr-md was found.' };
const row = (repo: string, next: ReleaseRowV1['next'], why: string): ReleaseRowV1 => ({
  repo, defaultBranch: ok('main'), latestTag: ok({ name: 'v1.0.0', ageDays: 3 }), commitsSinceTag: ok(next === 'nothing to release' ? 0 : 4), mergedPrsSinceTag: ok(2),
  changelog: ok(next === 'write changelog' ? 'not-updated-since-tag' : 'covers'), next, why,
});
const report = (repos: ReleaseRowV1[]): ReleasesV1 => ({ schema: RELEASES_SCHEMA, asOf: '2026-11-17T12:00:00.000Z', repos, summary: summarizeReleases(repos) });
const MIXED = report([
  row('phantom', 'ready: open release PR', '4 commits (2 PRs) since v1.0.0; the Unreleased section covers them.'),
  row('locus', 'write changelog', '4 commits (2 PRs) since v1.0.0, but CHANGELOG.md has not changed since the tag.'),
  row('lexicon', 'nothing to release', 'No commits since v1.0.0.'),
  { ...row('ashlr-md', 'unknown', gone.reason), defaultBranch: gone, latestTag: gone, commitsSinceTag: gone, mergedPrsSinceTag: gone, changelog: gone },
]);
const QUIET = report([row('phantom', 'nothing to release', 'No commits since v1.0.0.'), row('locus', 'nothing to release', 'No commits since v1.0.0.')]);
let viewport: ViewportMock | null = null;
const show = (data: unknown, width: number, status = 'success') => {
  viewport = mockViewport(width); state.read = { status, data };
  render(<ReleasesCard visible />);
  return within(screen.getByRole('region', { name: 'Releases' }));
};
afterEach(() => { cleanup(); viewport?.restore(); state.refetch.mockClear(); });

describe.each([['desktop width', 1440], ['390 px', 390]])('Releases card at %s', (_name, width) => {
  it('leads with what to do, lists only repos that need a step, and has one action', () => {
    const card = show(MIXED, width);
    expect(card.getByText('Ready to release: phantom. Write a changelog first: locus. Unknown: ashlr-md.')).toBeTruthy();
    expect(card.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'phantom: ready: open release PR. 4 commits (2 PRs) since v1.0.0; the Unreleased section covers them.',
      'locus: write changelog. 4 commits (2 PRs) since v1.0.0, but CHANGELOG.md has not changed since the tag.',
      'ashlr-md: unknown. No local checkout of ashlr-md was found.',
    ]);
    expect(card.getByText('Up to date: lexicon.')).toBeTruthy();
    expect(card.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(card.getByRole('button', { name: 'Check again' }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
  it('empty state: nothing to release is said in words, with no list', () => {
    const card = show(QUIET, width);
    expect(card.getByText('Nothing to release.')).toBeTruthy();
    expect(card.getByText('Up to date: phantom, locus.')).toBeTruthy();
    expect(card.queryAllByRole('listitem')).toHaveLength(0);
    expect(card.getAllByRole('button')).toHaveLength(1);
  });
  it('says so while reading, and shows unknown with a reason when the report cannot be read', () => {
    expect(show(undefined, width, 'loading').getByText('Reading releases…')).toBeTruthy(); cleanup();
    expect(show({ error: 'nope' }, width).getByText('Unknown: The release report could not be read.')).toBeTruthy(); cleanup();
    const card = show(undefined, width, 'error');
    expect(card.getByText('Unknown: The release report could not be read.')).toBeTruthy();
    expect(card.getAllByRole('button')).toHaveLength(1);
  });
});
