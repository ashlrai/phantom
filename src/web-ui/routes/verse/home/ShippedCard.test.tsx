import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShippedReport } from '../../../../core/release/shipped.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { ShippedCard } from './ShippedCard.js';

const state = vi.hoisted(() => ({
  read: { status: 'success', data: undefined as unknown, error: undefined as Error | undefined, updatedAt: null as number | null },
}));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read }));

const line = (text: string, number: number | null) => ({ text, number, mergedAt: '2026-11-16T10:00:00.000Z', repo: null, prs: number === null ? [] : [number] });
const HEADLINE = 'This week: 5 user-facing changes across 1 repo; biggest: Add a Shipped card to Home.';
const REPORT: ShippedReport = {
  schema: 'shipped.v1', version: 1, generatedAt: '2026-11-17T00:00:00.000Z', since: '2026-11-10T00:00:00.000Z', days: 7,
  source: 'ok', note: null, repo: null, headline: HEADLINE, repos: 1, biggest: 'Add a Shipped card to Home', total: 7, maintenance: 2,
  areas: [
    { id: 'desktop', label: 'Desktop app', count: 4, lines: [line('Add a Shipped card to Home.', 108), line('Restore the window size after restart.', 102), line('Third.', 99)] },
    { id: 'cli', label: 'CLI', count: 1, lines: [line('Add phm shipped.', 103)] },
  ],
};
let viewport: ViewportMock | null = null;
const show = (data: unknown, width = 390, status = 'success') => {
  viewport = mockViewport(width);
  state.read = { status, data, error: status === 'error' ? new Error('HTTP 503') : undefined, updatedAt: status === 'success' ? Date.now() : null };
  return render(<ShippedCard />);
};
afterEach(() => { cleanup(); viewport?.restore(); viewport = null; });

describe.each([['390 px', 390], ['desktop width', 1440]])('Shipped card at %s', (_name, width) => {
  it('shows the count, two plain sentences per area, the rest as a number, and the maintenance count', () => {
    show(REPORT, width);
    const card = within(screen.getByRole('region', { name: 'Shipped' }));
    expect(card.getByText(HEADLINE)).toBeTruthy();
    expect(within(card.getByRole('list', { name: 'Desktop app' })).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Desktop app: 4', 'Add a Shipped card to Home.', 'Restore the window size after restart.', 'and 2 more',
    ]);
    expect(within(card.getByRole('list', { name: 'CLI' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['CLI: 1', 'Add phm shipped.']);
    expect(card.getByText('Maintenance: 2 changes (tests and chores).')).toBeTruthy();
    expect(card.getByText('phm shipped').tagName).toBe('CODE');
    expect(card.queryAllByRole('button')).toHaveLength(0);
  });

  it('empty week: says nothing merged', () => {
    show({ ...REPORT, total: 0, maintenance: 0, areas: [] }, width);
    const card = within(screen.getByRole('region', { name: 'Shipped' }));
    expect(card.getByText('Nothing merged in the last 7 days.')).toBeTruthy();
    expect(card.queryByRole('list')).toBeNull();
  });
});

it('shows a partial-history note beside the list', () => {
  show({ ...REPORT, source: 'partial', note: 'This checkout has shortened git history, so some changes may be missing.' });
  expect(screen.getByText('This checkout has shortened git history, so some changes may be missing.').hasAttribute('data-unknown')).toBe(true);
});

it('says unknown when nothing could be read, and stays hidden before the read or for another payload', () => {
  show({ ...REPORT, source: 'unknown', note: 'No git history could be read here.', total: null, maintenance: null, areas: [] });
  expect(screen.getByText('Unknown: No git history could be read here.')).toBeTruthy();
  cleanup();
  show(undefined, 390, 'error');
  expect(screen.getByRole('status').textContent).toBe('What shipped is unavailable right now. Try again.');
  cleanup();
  for (const data of [undefined, { error: 'nope' }, { schema: 'home.v1' }]) {
    expect(show(data).container.innerHTML).toBe('');
    cleanup();
  }
});
