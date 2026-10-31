import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetChannelsPane } from './FleetChannelsPane.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const fixture = () => fleetRunsFixture({ inbox: [
  { at: '2026-10-31T04:59:00Z', source: 'Telegram', text: 'fake telegram message' },
  { at: '2026-10-31T03:00:00Z', source: 'desktop app', text: 'fake desktop message' },
  { at: '2026-10-31T04:30:00Z', source: 'phantom page', text: 'fake page message' },
] });
const openPane = vi.fn();
const props = { visible: true, host: { openPane } } as unknown as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the channel board and opens the shared inbox', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetChannelsPane {...props} />);
  expect(await screen.findByText('3 of 7 channels heard from · 3 messages in 24 h')).toBeInTheDocument();
  const rows = within(screen.getByRole('list', { name: 'Channels' })).getAllByRole('listitem');
  expect(rows).toHaveLength(7);
  expect(rows[0]).toHaveTextContent('Telegram last 1m ago');
  expect(rows[0]).toHaveTextContent('1 / 1 h · 1 / 24 h');
  expect(within(rows[0]).getByText('fake telegram message')).toBeInTheDocument();
  expect(within(rows[0]).getByText('1m ago')).toHaveAttribute('dateTime', '2026-10-31T04:59:00Z');
  expect(rows[1]).toHaveTextContent('Phantom page');
  expect(rows[2]).toHaveTextContent('Desktop app');
  expect(rows[2]).toHaveTextContent('0 / 1 h · 1 / 24 h');
  expect(screen.getByText('Silent: Terminal, Email, Fleet-say, Mobile')).toBeInTheDocument();
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Open inbox' }));
  expect(openPane).toHaveBeenCalledWith('fleet-inbox');
});

it('shows a degraded source and refresh failures with cached data', async () => {
  const data = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, sources: { ...data.sources, inbox: 'degraded' } })));
  render(<FleetChannelsPane {...props} />);
  expect(await screen.findByText('Inbox data may be incomplete.')).toBeInTheDocument();
  await act(async () => { await refetchQuery('verse-fleet-runs', async () => { throw new Error('offline'); }, true); });
  expect(screen.getByText('Live runs could not refresh. Showing the last reading.')).toBeInTheDocument();
});

it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetChannelsPane {...props} />);
  expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
});

it('polls only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json(fixture()));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetChannelsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetChannelsPane {...props} />); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<FleetChannelsPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
