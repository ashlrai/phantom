import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetExperimentsPane } from './FleetExperimentsPane.js';
import type { OpsFleetV1 } from '../../../../core/verse/ops-types.js';

const fixture = (): OpsFleetV1 => ({
  v: 1, generatedAt: '', tickAt: null, lanes: null, holdProduction: null, held: [], decisions: [],
  sources: { tick: 'healthy', journal: 'healthy', learning: 'healthy' },
  experiments: ['positive', 'unclear', 'unknown'].map((id, i) => ({
    id, hypothesisId: null, arms: { base: 'base', candidate: id }, status: i === 2 ? 'running' : 'done',
    pairs: 10, wins: 6, losses: 3, ties: 1, lift: i === 2 ? null : i === 1 ? { mean: 0, ciLow: -1, ciHigh: 1 } : { mean: 2, ciLow: 1, ciHigh: 3 },
    verdict: i === 2 ? null : 'adopt', reasons: ['Evidence'], startedAt: '2026-01-01', finishedAt: i === 2 ? null : '2026-01-02',
  })),
});

const props = { visible: true } as PaneProps;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows intervals, counts, unknowns and expandable details', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetExperimentsPane {...props} />);
  expect(await screen.findByText('3 experiments · 1 helped · 0 hurt · 1 unclear')).toBeInTheDocument();
  const details = within(screen.getByRole('list', { name: 'Experiment details' }));
  expect(details.getAllByRole('listitem')).toHaveLength(3);
  const positive = details.getByText('base → positive · helped');
  positive.click();
  expect(positive.closest('details')).toHaveAttribute('open');
  expect(within(positive.closest('details')!).getByText('Started: 2026-01-01')).toBeVisible();
  expect(document.querySelector('[data-row="positive"] [data-role="ci"]')).toBeInTheDocument();
  expect(document.querySelector('[data-row="unknown"] [data-role="unknown"]')).toBeInTheDocument();
  expect(details.getByText('base → unclear · unclear')).toBeInTheDocument();
  expect(details.getByText('base → unknown · unknown')).toBeInTheDocument();
  expect(screen.getAllByText('not enough pairs yet').length).toBeGreaterThan(0);
  expect(details.getAllByText('6W 3L 1T · done · adopt')).toHaveLength(2);
  expect(details.getAllByText('Evidence')).toHaveLength(3);
});

it('reports degraded and empty sources', async () => {
  const data = fixture(); data.sources.learning = 'degraded'; data.experiments = [];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetExperimentsPane {...props} />);
  expect(await screen.findByText('Experiment data may be incomplete.')).toBeInTheDocument();
  expect(screen.getByText('No calibration experiments yet.')).toBeInTheDocument();
});

it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetExperimentsPane {...props} />);
  expect(await screen.findByText('Experiments not in this build')).toBeInTheDocument();
});

it('keeps the last reading on refresh failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetExperimentsPane {...props} />);
  await screen.findByText('3 experiments · 1 helped · 0 hurt · 1 unclear');
  await act(async () => { await refetchQuery('verse-ops-fleet', async () => { throw new Error('offline'); }, true); });
  expect(screen.getByText('Experiments could not refresh. Showing the last reading.')).toBeInTheDocument();
});

it('polls every 30 seconds only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetExperimentsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetExperimentsPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetExperimentsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
