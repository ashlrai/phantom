import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetEventsPane } from './FleetEventsPane.js';

const props = { visible: true } as PaneProps;
const event = (at: string, kind: string, text: string) => ({ at, kind, text });
const fixture = () => ({
  events: [event('2026-01-01T00:00:00Z', 'launch', 'first'), event('2026-01-02T00:00:00Z', 'hold', '<img>'),
    event('2026-01-03T00:00:00Z', 'launch', 'second'), event('bad', 'tick', 'bad time')],
  publishesLastHour: [{ job: 'job-1', at: '2026-01-04T00:00:00Z', url: 'https://github.com/a/b/pull/1' }],
  leaders: [{ label: 'alpha', ageSeconds: 30 }], orchestratorAgents: 2,
  drop: { pending: [{ lane: 'fake', file: 'fake.json' }], done: 0 }, sources: { runsDir: 'healthy' },
});
const rows = () => within(screen.getByRole('list', { name: 'Fleet event feed' })).getAllByRole('listitem');
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows newest first, filters kinds, escapes text and handles unknown dates', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  const { container } = render(<FleetEventsPane {...props} />);
  expect(await screen.findByText('Leaders: alpha 30s · 2 agents · 1 job files pending')).toBeInTheDocument();
  expect(rows().map(row => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('job-1')]));
  expect(rows().map(row => row.textContent?.match(/job-1|second|<img>|first|bad time/)?.[0])).toEqual(['job-1', 'second', '<img>', 'first', 'bad time']);
  expect(container.querySelector('img')).toBeNull();
  expect(rows()[4]).toHaveTextContent('—');
  expect(screen.getByRole('link', { name: 'Pull request for job-1' })).toHaveAttribute('href', 'https://github.com/a/b/pull/1');
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['hold', 'launch', 'publish', 'tick', 'Pause']);
  fireEvent.click(screen.getByRole('button', { name: 'launch' }));
  expect(rows()).toHaveLength(2);
});

it('freezes the list and counts distinct arrivals across refreshes until resumed', async () => {
  const first = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(first)));
  render(<FleetEventsPane {...props} />);
  await screen.findByText('first');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  const next = { ...first, events: [...first.events, event('2026-01-05T00:00:00Z', 'launch', 'third'), event('2026-01-06T00:00:00Z', 'hold', 'fourth')] };
  await act(async () => { await refetchQuery('verse-fleet-runs', async () => next, true); });
  expect(rows()).toHaveLength(5);
  expect(screen.getByRole('button', { name: /2 new/ })).toBeInTheDocument();
  await act(async () => { await refetchQuery('verse-fleet-runs', async () => first, true); });
  expect(screen.getByRole('button', { name: /2 new/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
  expect(rows()).toHaveLength(7);
  expect(rows()[0]).toHaveTextContent('fourth');
});

it('reports unknown header values, degraded sources, empty feed and unavailable route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ leaders: [], drop: null, sources: { runsDir: 'degraded' } })));
  const view = render(<FleetEventsPane {...props} />);
  expect(await screen.findByText('Leaders: — · — agents · — job files pending')).toBeInTheDocument();
  expect(screen.getByText('Dispatcher events may be incomplete.')).toBeInTheDocument();
  expect(screen.getByText('No fleet events yet.')).toBeInTheDocument();
  view.unmount(); evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetEventsPane {...props} />);
  expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
});

it('does not fetch or poll while hidden, and polls while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetEventsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetEventsPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetEventsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { view.rerender(<FleetEventsPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
