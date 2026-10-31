import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDecisionsPane } from './FleetDecisionsPane.js';
import { fixture } from './fixtures.js';

const props = { visible: true } as PaneProps;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the decisions, holds and filter', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetDecisionsPane {...props} />);
  expect(await screen.findByText(/2 launched · 1 skipped · tick/)).toBeInTheDocument();
  expect(screen.getByText('Production is held: maintenance')).toBeInTheDocument();
  const list = within(screen.getByRole('list', { name: 'Decisions' }));
  expect(list.getAllByRole('listitem')).toHaveLength(3);
  expect(list.getAllByRole('listitem')[0]).toHaveTextContent('Second');
  expect(list.getByText('No seat')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Held items' })).getByText(/cooldown · Waiting/)).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Held items' })).getByRole('listitem')).toHaveTextContent(/lifts in/);
  fireEvent.click(screen.getByRole('radio', { name: 'Skipped' }));
  expect(screen.getByRole('radio', { name: 'Skipped' })).toHaveAttribute('aria-checked', 'true');
  expect(list.getAllByRole('listitem')).toHaveLength(1);
  expect(list.getByText(/Third/)).toBeInTheDocument();
});

it('reports stalled and degraded journal data', async () => {
  const data = fixture(); data.decisions = data.decisions.filter(d => !d.dispatched); data.sources.journal = 'degraded'; data.held[0].nextEligibleAt = null;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetDecisionsPane {...props} />);
  expect(await screen.findByText('No launches in the journal window; last skip: No seat')).toHaveAttribute('role', 'status');
  expect(screen.getByText('Decision data may be incomplete.')).toBeInTheDocument();
  expect(screen.getByText('no lift time')).toBeInTheDocument();
});

it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetDecisionsPane {...props} />);
  expect(await screen.findByText('Decisions not in this build')).toBeInTheDocument();
});

it('polls every 15 seconds only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture())); vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetDecisionsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetDecisionsPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetDecisionsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps the last reading when a refresh fails', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(fixture())).mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetDecisionsPane {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByText('Decisions could not refresh. Showing the last reading.')).toBeInTheDocument();
  expect(screen.getByText(/2 launched · 1 skipped/)).toBeInTheDocument();
});
