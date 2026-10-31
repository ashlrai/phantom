import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';

const props = { visible: true } as PaneProps;
const fixture = () => ({
  mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 12, title: 'bridge: RQ-DONE' }] },
  publishesLastHour: [{ job: 'RQ-DONE', lane: 'a', at: '2026-01-01T00:00:00Z', url: null }, { job: 'RQ-WAIT', lane: 'b', at: '2026-01-02T00:00:00Z', url: 'https://github.com/ashlrai/phantom/pull/13' }],
  lanes: [{ lane: 'a', merged24h: 4, mergeRate24h: 75 }, { lane: 'b', merged24h: null, mergeRate24h: null }],
  sources: { merges: 'healthy' },
});
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders merged PRs, waiting publishes and lane throughput', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetMergesPane {...props} />);
  expect(await screen.findByText('1 merged in the last hour · 1 publishes waiting')).toBeInTheDocument();
  const merged = within(screen.getByRole('list', { name: 'Merged PRs' }));
  expect(merged.getByText('bridge: RQ-DONE')).toBeInTheDocument();
  expect(merged.getByRole('link')).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/12');
  const pending = within(screen.getByRole('list', { name: 'Publishes waiting' }));
  expect(pending.getAllByRole('listitem')).toHaveLength(1);
  expect(pending.getByRole('link', { name: 'RQ-WAIT' })).toHaveAttribute('target', '_blank');
  expect(pending.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  const lanes = within(screen.getByRole('list', { name: 'Lane throughput' }));
  expect(lanes.getAllByRole('listitem')[0]).toHaveTextContent('a 4 merged · 75.0%');
  expect(lanes.getAllByRole('listitem')[1]).toHaveTextContent('b — merged · —');
  expect(screen.queryByText('Merge data may be incomplete.')).not.toBeInTheDocument();
});

it('reports a degraded merge source and unknown count', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fixture(), mergesLastHour: { count: null, items: [] }, sources: { merges: 'degraded' } })));
  render(<FleetMergesPane {...props} />);
  expect(await screen.findByText('Merge data may be incomplete.')).toBeInTheDocument();
  expect(screen.getByText('— merged in the last hour · 2 publishes waiting')).toBeInTheDocument();
  expect(screen.getByText('No merged PRs reported.')).toBeInTheDocument();
});

it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetMergesPane {...props} />);
  expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
});

it('polls every ten seconds only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetMergesPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetMergesPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetMergesPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('updates from the shared fleet runs cache', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetMergesPane {...props} />);
  await screen.findByText('1 merged in the last hour · 1 publishes waiting');
  await act(async () => { await refetchQuery('verse-fleet-runs', async () => ({ ...fixture(), mergesLastHour: { count: 0, items: [] } }), true); });
  expect(screen.getByText('0 merged in the last hour · 2 publishes waiting')).toBeInTheDocument();
});
