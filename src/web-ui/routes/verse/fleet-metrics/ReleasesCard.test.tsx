import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { releaseCadence, type ReleasesReport } from '../../../../core/release/status.js';
import { ReleasesCard } from './ReleasesCard.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const cells = (name: RegExp) => within(screen.getByRole('row', { name })).getAllByRole('cell').map(cell => cell.textContent);

it('shows each repo, marks the due ones and names the release to do next', () => {
  render(<ReleasesCard report={releaseCadence([
    { repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: '2026-11-16T12:00:00Z', mergedPrsSinceTag: 4 },
    { repo: 'ashlrai/locus', latestTag: 'v0.9.1', taggedAt: '2026-11-07T12:00:00Z', mergedPrsSinceTag: 62 },
    { repo: 'ashlrai/lexicon', latestTag: null, taggedAt: null, mergedPrsSinceTag: null },
    { repo: 'ashlrai/ashlr-md', latestTag: null, taggedAt: null, mergedPrsSinceTag: null, readable: false },
  ], now)} />);
  expect(screen.getByText(/^Release next: locus: 62 PRs since v0\.9\.1 11 days ago; release due\. Due means over 7 days or over 50 merged PRs/)).toBeTruthy();
  expect(cells(/^phantom/)).toEqual(['v3.1.0', '2', '4', 'fresh']);
  expect(cells(/^locus/)).toEqual(['v0.9.1', '11', '62', 'due']);
  expect(screen.getByRole('row', { name: /^locus/ }).getAttribute('data-due')).toBe('true');
  expect(cells(/^lexicon/)).toEqual(['none', '', 'unknown', 'no release yet']);
  expect(cells(/^ashlr-md/)).toEqual(['unknown', '', 'unknown', 'unknown']);
});

it('says so when nothing is due and when there are no repos', () => {
  const { unmount } = render(<ReleasesCard report={releaseCadence([{ repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: '2026-11-18T00:00:00Z', mergedPrsSinceTag: 1 }], now)} />);
  expect(screen.getByText(/^No release is due\./)).toBeTruthy();
  unmount();
  render(<ReleasesCard report={releaseCadence([], now)} />);
  expect(screen.getByText('No repos to check.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

it('reads unknown while loading and for a reply that is not the releases report', () => {
  const { rerender } = render(<ReleasesCard report={undefined} />);
  expect(screen.getByText('Releases: unknown')).toBeTruthy();
  rerender(<ReleasesCard report={{ error: 'not found' } as unknown as ReleasesReport} />);
  expect(screen.getByText('Releases: unknown')).toBeTruthy();
});

it('lists up to five merged PR titles per repo as plain text, with the number left over', () => {
  const titles = Array.from({ length: 7 }, (_, i) => ({ number: 70 - i, title: `change ${7 - i}` }));
  render(<ReleasesCard report={releaseCadence([
    { repo: 'ashlrai/locus', latestTag: 'v0.9.1', taggedAt: '2026-11-07T12:00:00Z', mergedPrsSinceTag: 7, mergedPrs: titles },
    { repo: 'ashlrai/phantom', latestTag: 'v3.1.0', taggedAt: '2026-11-17T12:00:00Z', mergedPrsSinceTag: 0, mergedPrs: [] },
    { repo: 'ashlrai/lexicon', latestTag: 'v1.0.0', taggedAt: '2026-11-17T12:00:00Z', mergedPrsSinceTag: null, mergedPrs: null },
  ], now)} />);
  expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['#70 change 7', '#69 change 6', '#68 change 5', '#67 change 4', '#66 change 3']);
  expect(screen.getByText(/and 2 more/)).toBeTruthy();
  expect(screen.queryByText(/^phantom merged since/)).toBeNull();
});
