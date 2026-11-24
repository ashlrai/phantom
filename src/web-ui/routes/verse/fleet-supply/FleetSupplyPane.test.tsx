import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';
import { supplyFixture } from './supply-fixture.js';

const props = { visible: true } as PaneProps;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const readings = (card: HTMLElement) => within(card).getAllByRole('definition').map(cell => cell.textContent);

it('renders demand, lane counts, waiting, held reason and assumptions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(supplyFixture())));
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByRole('heading', { name: 'Write 5 more job files · Shortfall 5 slots' })).toBeInTheDocument();
  const cards = within(screen.getByRole('list', { name: 'Job supply per lane' })).getAllByRole('listitem');
  expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['active', 'over', 'held']);
  expect(within(cards[0]).getAllByRole('term').map(term => term.textContent))
    .toEqual(['Running / target', 'Free now', 'Freeing ≤15 m', 'Waiting', 'Shortfall']);
  expect(readings(cards[0])).toEqual(['3/8', '5', '2', '3', '4']);
  expect(cards[0].querySelector('strong')).toHaveTextContent('4');
  expect(screen.getByText('Quota exhausted')).toBeInTheDocument();
  expect(screen.getByText('Claude lane down for maintenance')).toBeInTheDocument();
  expect(screen.getByText(/assumes ~15 min per job/)).toBeInTheDocument();
});

it('draws a square per opening slot and says each lane state in words', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(supplyFixture())));
  render(<FleetSupplyPane {...props} />);
  const [active, over, held] = within(await screen.findByRole('list', { name: 'Job supply per lane' })).getAllByRole('listitem');
  const picture = within(active).getByRole('img', { name: 'active: 3 of 7 opening slots have a job waiting' });
  expect([...picture.children].map(mark => mark.getAttribute('data-pip')))
    .toEqual(['covered', 'covered', 'covered', 'short', 'short', 'short', 'short']);
  expect(active).toHaveAttribute('data-state', 'short');
  expect(within(active).getByText('4 short')).toBeInTheDocument();
  expect(within(active).getByText('3 of 7 opening slots covered')).toBeInTheDocument();
  expect(within(over).getByText('1 short')).toBeInTheDocument();
  // A held lane is left out of the shortfall and says so instead of showing a zero.
  expect(held).toHaveAttribute('data-state', 'held');
  expect(within(held).getByText('Held, not counted')).toBeInTheDocument();
  expect(readings(held).at(-1)).toBe('none while held');
  expect(screen.getByText('8 slots open within 15 min · 3 jobs waiting · 1 lane held')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: '3 of 8 opening slots have a job waiting' }).children).toHaveLength(2);
});

it.each(['null drop', 'degraded source'])('reports pending counts unknown for %s', async condition => {
  const fixture = supplyFixture();
  const data = condition === 'null drop' ? { ...fixture, drop: null } : { ...fixture, sources: { runsDir: 'degraded' } };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByText('Drop folder unreadable: pending counts unknown')).toBeInTheDocument();
});

it('states the shortfall as an upper bound when the pending files could not be counted', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...supplyFixture(), drop: null })));
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByRole('heading', { name: 'Write up to 7 more job files · Shortfall up to 7 slots' })).toBeInTheDocument();
  const active = within(screen.getByRole('list', { name: 'Job supply per lane' })).getAllByRole('listitem')[0];
  expect(readings(active)).toEqual(['3/8', '5', '2', '1 queued, files unknown', 'up to 6']);
  expect(within(active).getByText('up to 6 short')).toBeInTheDocument();
  expect(screen.getByText('8 slots open within 15 min · 1 queued, job files unknown · 1 lane held')).toBeInTheDocument();
});

it('explains a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
});

it('fetches and polls every ten seconds only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(supplyFixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetSupplyPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetSupplyPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetcher).toHaveBeenCalledTimes(4);
  view.rerender(<FleetSupplyPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).toHaveBeenCalledTimes(4);
});
