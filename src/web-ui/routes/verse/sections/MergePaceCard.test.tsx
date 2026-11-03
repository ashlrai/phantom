import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { MergePaceCard, mergePaceLine } from './MergePaceCard.js';
import { isMergePaceReport } from './merge-pace-query.js';

const report = {
  schema: 'fleet.merge-pace.v1', known: true, window_hours: 6,
  rows: [
    { repo: 'o/one', merges: 12, merges_per_hour: 2, median_ttm_s: 750 },
    { repo: 'o/two', merges: 1, merges_per_hour: 1 / 6, median_ttm_s: 40 },
    { repo: 'o/three', merges: 2, merges_per_hour: 1 / 3, median_ttm_s: null },
    { repo: 'total', merges: 15, merges_per_hour: 2.5, median_ttm_s: 5400 },
  ],
};

const serve = (data: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows merges per hour and median time to merge per repo, plus the total', async () => {
  serve(report);
  render(<MergePaceCard />);
  const list = await screen.findByRole('list', { name: 'Merge pace per repo' });
  expect(screen.getByText('Merge pace, last 6 hours')).toBeInTheDocument();
  expect(within(list).getAllByRole('listitem')).toHaveLength(4);
  expect(within(list).getByText('o/one').parentElement).toHaveTextContent('o/one · 12 merges · 2 per hour · median 13 min to merge');
  expect(within(list).getByText('o/two').parentElement).toHaveTextContent('o/two · 1 merge · 0.2 per hour · median 40 sec to merge');
  expect(within(list).getByText('o/three').parentElement).toHaveTextContent('2 merges · 0.3 per hour · time to merge unknown');
  expect(within(list).getByText('total').parentElement).toHaveTextContent('total · 15 merges · 2.5 per hour · median 1.5 hr to merge');
});

it('says unknown plainly when the metrics could not be read — never zero', async () => {
  serve({ schema: 'fleet.merge-pace.v1', known: false, window_hours: 6, rows: null });
  render(<MergePaceCard />);
  expect(await screen.findByText('Unknown — the merge history could not be read.')).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Merge pace per repo' })).not.toHaveTextContent('0 merges');
});

it('says so when nothing merged in the window', async () => {
  serve({ schema: 'fleet.merge-pace.v1', known: true, window_hours: 6,
    rows: [{ repo: 'total', merges: 0, merges_per_hour: 0, median_ttm_s: null }] });
  render(<MergePaceCard />);
  expect(await screen.findByText('No merges in the last 6 hours.')).toBeInTheDocument();
});

it('says nothing when the route is not in this build', async () => {
  serve({}, 404);
  const { container } = render(<MergePaceCard />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it('formats a row line in plain words', () => {
  expect(mergePaceLine({ repo: 'o/a', merges: 1, merges_per_hour: 1 / 6, median_ttm_s: 120 }))
    .toBe('1 merge · 0.2 per hour · median 2 min to merge');
});

it('accepts only the fleet.merge-pace.v1 shape', () => {
  expect(isMergePaceReport(report)).toBe(true);
  expect(isMergePaceReport({ ...report, schema: 'v2' })).toBe(false);
  expect(isMergePaceReport({ ...report, known: false })).toBe(false);
  expect(isMergePaceReport({ ...report, rows: [{ repo: 'x', merges: -1, merges_per_hour: 0, median_ttm_s: null }] })).toBe(false);
});
