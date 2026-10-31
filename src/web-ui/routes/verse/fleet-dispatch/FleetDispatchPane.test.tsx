import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';

const openTerminal = vi.fn();
const props = { visible: true, roots: ['/workspace'], host: { openTerminal } } as unknown as PaneProps;
const nowMs = Date.parse('2026-10-31T05:09:00Z');
const base = fleetRunsFixture().lanes[0]!;
const fixture = () => fleetRunsFixture({ claudeLane: 'down — token rejected', lanes: [
  { ...base, lane: 'devin', running: 4 },
  { ...base, lane: 'codex-cmp', held: true, heldReason: 'usage limit' },
  { ...base, lane: 'claude' },
  { ...base, running: 0, queued: 17 },
] });
beforeEach(() => { evictAll(); openTerminal.mockClear(); vi.spyOn(Date, 'now').mockReturnValue(nowMs); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders danger-first verdicts and pastes the Claude fix with only supported request fields', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetDispatchPane {...props} />);
  const list = await screen.findByRole('list', { name: 'Lane verdicts' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows.map(row => row.querySelector('strong')?.textContent)).toEqual(['claude', 'codex-personal', 'codex-cmp', 'devin']);
  expect(rows[1]).toHaveTextContent('4 free, 17 queued — last tick 9 min ago');
  expect(openTerminal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Paste in Terminal' }));
  expect(openTerminal).toHaveBeenCalledExactlyOnceWith({ root: '/workspace', paste: '~/.ashlr-runs/bin/fix-claude-lane.sh' });
});
it('omits the terminal root when no folder is open', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetDispatchPane {...props} roots={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Paste in Terminal' }));
  expect(openTerminal).toHaveBeenCalledExactlyOnceWith({ paste: '~/.ashlr-runs/bin/fix-claude-lane.sh' });
});
it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetDispatchPane {...props} />);
  expect(await screen.findByText('Live runs not in this build')).toBeInTheDocument();
});
it('renders the shared stall incident', async () => {
  const runs = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...runs, events: [{ at: '2026-10-31T04:00:00Z', kind: 'launch', text: '' }], publishesLastHour: [], mergesLastHour: { count: 0, items: [] } })));
  render(<FleetDispatchPane {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Fleet stalled No launches, publishes or merges for 69 min. Run the leader:');
});
it('shows loading, errors and malformed snapshots', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<FleetDispatchPane {...props} />);
  expect(screen.getByText('Reading live runs…')).toBeInTheDocument();
  expect(await screen.findByText('Live runs are unavailable.')).toBeInTheDocument();
  await act(async () => { await refetchQuery('verse-fleet-runs', async () => ({ v: 1 }), true); });
  expect(screen.getByText('Live runs are unavailable.')).toBeInTheDocument();
});
it('polls only while visible, advances stale verdicts and shares cache updates', async () => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-31T05:05:00Z'));
  const fetcher = vi.fn(async () => Response.json(fleetRunsFixture({ claudeLane: null, lanes: [{ ...base, queued: 17 }] })));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetDispatchPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).not.toHaveBeenCalled();
  vi.setSystemTime(Date.parse('2026-10-31T05:05:00Z'));
  await act(async () => { view.rerender(<FleetDispatchPane {...props} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText(/— launching/)).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByText(/last tick 5 min ago/)).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { await refetchQuery('verse-fleet-runs', async () => fleetRunsFixture({ claudeLane: null, sources: { ...fleetRunsFixture().sources, runsDir: 'degraded' } }), true); });
  expect(screen.getByText('Dispatch data may be incomplete.')).toBeInTheDocument();
  view.rerender(<FleetDispatchPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
