import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';
import { supplyLedgerQuery } from './supply-ledger-query.js';
import { supplyFixture } from './supply-fixture.js';

const now = new Date(2026, 10, 4, 7, 30).getTime();
const ledger = {
  v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: null, apiSpend: null,
  lanes: [{ lane: 'active', running: 3, target: 8, held: false, window: 'weekly', usedPct: 77, creditsRemaining: null, resetAt: null, burnPctPerHour: 5, tokensPerHour6h: null, projectedExhaustion: new Date(now + 4 * 3_600_000).toISOString(), source: null }],
};
const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the projected exhaustion in the lane and headline', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? supplyFixture() : ledger)));
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByRole('heading', { name: 'Write 5 more job files · active runs out in 4 h' })).toBeInTheDocument();
  const lane = screen.getByRole('rowheader', { name: /active/ });
  expect(within(lane).getByText(/^runs out ≈ 11:30 .* \(in 4 h\)$/)).toHaveAttribute('data-tone', 'warn');
});

it('keeps the original rows and headline when the ledger is missing', async () => {
  const fetcher = vi.fn(async (url: string) => url.includes('/fleet/runs') ? Response.json(supplyFixture()) : Response.json({}, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByRole('heading', { name: 'Write 5 more job files' })).toBeInTheDocument();
  await screen.findByText('Quota exhausted');
  expect(screen.getByRole('rowheader', { name: 'active' })).toHaveTextContent(/^active$/);
  expect(within(screen.getByRole('table')).getAllByRole('row')[1]?.querySelectorAll('td')).toHaveLength(5);
});

it('memoizes a missing ledger endpoint for a query visit', async () => {
  const fetcher = vi.fn(async () => Response.json({}, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const query = supplyLedgerQuery();
  expect(await query.fetch()).toBeNull();
  expect(await query.fetch()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await supplyLedgerQuery().fetch()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('polls both endpoints only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? supplyFixture() : ledger));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetSupplyPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetSupplyPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledTimes(4);
  view.rerender(<FleetSupplyPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).toHaveBeenCalledTimes(4);
});
