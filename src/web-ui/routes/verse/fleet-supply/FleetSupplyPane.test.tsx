import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';
import { supplyFixture } from './supply-fixture.js';

const props = { visible: true } as PaneProps;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders demand, lane counts, waiting, held reason and assumptions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(supplyFixture())));
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByRole('heading', { name: 'Write 5 more job files' })).toBeInTheDocument();
  const rows = within(screen.getByRole('table')).getAllByRole('row');
  expect(rows).toHaveLength(4);
  expect(within(rows[1]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['3/8', '5', '2', '3', '4']);
  expect(rows[1].querySelector('strong')).toHaveTextContent('4');
  expect(screen.getByText('Quota exhausted')).toBeInTheDocument();
  expect(screen.getByText('Claude lane down for maintenance')).toBeInTheDocument();
  expect(screen.getByText(/assumes ~15 min per job/)).toBeInTheDocument();
});

it.each(['null drop', 'degraded source'])('reports pending counts unknown for %s', async condition => {
  const fixture = supplyFixture();
  const data = condition === 'null drop' ? { ...fixture, drop: null } : { ...fixture, sources: { runsDir: 'degraded' } };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetSupplyPane {...props} />);
  expect(await screen.findByText('Drop folder unreadable: pending counts unknown')).toBeInTheDocument();
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
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetSupplyPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
