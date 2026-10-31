import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSteeringPane } from './FleetSteeringPane.js';

const props = { visible: true } as PaneProps;
const entry = (at: string, text: string, source = 'Phantom desktop') => ({ at, source, text });
const event = (at: string, kind: string, text: string) => ({ at, kind, text });
const fixture = () => ({
  sources: { runsDir: 'healthy', inbox: 'healthy' },
  inbox: [entry('2026-10-31 00:01', 'first order'), entry('2026-10-31 00:13', 'second order, push the release')],
  events: [
    event('2026-10-31T00:03:00Z', 'LEADER', 'leader pass'),
    event('2026-10-31T00:14:00Z', 'LAUNCH', 'launched worker a'),
    event('2026-10-31T00:15:00Z', 'PUBLISHED', 'published the PR'),
  ],
});
const rows = () => within(screen.getByRole('list', { name: 'Steering orders' })).getAllByRole('listitem');
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders orders newest first with reaction summaries, and expands an order into its events', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetSteeringPane {...props} />);
  const list = await screen.findByRole('list', { name: 'Steering orders' });
  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringContaining('second order, push the release'),
    expect.stringContaining('first order'),
  ]);
  expect(list).toHaveTextContent('1 launch, 1 publish');
  expect(list).toHaveTextContent('1 pass');
  expect(list).toHaveTextContent('leaders reacted in 2 min');
  // The expand toggle lists the dispatcher events inside that order's window.
  const second = rows()[0];
  expect(within(second).queryByText('launched worker a')).toBeNull();
  fireEvent.click(within(second).getByRole('button', { name: 'Events' }));
  const events = within(second).getByRole('list', { name: 'Events after 2026-10-31 00:13' });
  expect(within(events).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    expect.stringContaining('launched worker a'),
    expect.stringContaining('published the PR'),
  ]);
  expect(events).toHaveTextContent('LAUNCH');
  expect(events).toHaveTextContent('PUBLISHED');
  fireEvent.click(within(second).getByRole('button', { name: 'Hide events' }));
  expect(within(second).queryByText('launched worker a')).toBeNull();
});

it('truncates long orders at 160 chars and reports a quiet window', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    sources: { runsDir: 'healthy', inbox: 'healthy' },
    inbox: [entry('2026-10-31 00:13', `${'x'.repeat(160)}SECRET_TAIL`)],
    events: [],
  })));
  render(<FleetSteeringPane {...props} />);
  const list = await screen.findByRole('list', { name: 'Steering orders' });
  expect(list).toHaveTextContent('…');
  expect(list).not.toHaveTextContent('SECRET_TAIL');
  expect(list).toHaveTextContent('No leader pass yet');
  expect(list).not.toHaveTextContent('leaders reacted');
  fireEvent.click(screen.getByRole('button', { name: 'Events' }));
  expect(screen.getByText('No dispatcher events in this window.')).toBeInTheDocument();
});

it('shows the empty state, the degraded notice and the 404 message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sources: { runsDir: 'healthy', inbox: 'healthy' }, inbox: [], events: [] })));
  const view = render(<FleetSteeringPane {...props} />);
  expect(await screen.findByText('No orders yet. Use the interject box.')).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Last exchange' })).toHaveTextContent('no order recorded yet');
  view.unmount(); evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sources: { runsDir: 'degraded', inbox: 'healthy' }, inbox: [entry('2026-10-31 00:13', 'go')], events: [] })));
  const degraded = render(<FleetSteeringPane {...props} />);
  expect(await screen.findByText('Inbox or dispatcher events may be incomplete.')).toBeInTheDocument();
  degraded.unmount(); evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetSteeringPane {...props} />);
  expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
});

it('does not fetch while hidden and polls every 10 s while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetSteeringPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetSteeringPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledTimes(4);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledTimes(6);
});
