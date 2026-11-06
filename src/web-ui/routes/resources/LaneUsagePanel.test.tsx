import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../data/cache.js';
import type { FleetUsageLane, FleetUsageV1 } from './fleet-usage-model.js';
import { LaneUsagePanel, LANE_USAGE_POLL_MS } from './LaneUsagePanel.js';

const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./fleet-usage-source.js', () => ({
  fleetUsageQuery: { key: 'fleet-usage', fetch: (signal?: AbortSignal) => loader.load(signal) },
}));

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const lane = (patch: Partial<FleetUsageLane>): FleetUsageLane => ({
  lane: 'claude', window: 'weekly', usedPct: 40, resetAt: new Date(NOW + 10 * 3_600_000).toISOString(), burnPctPerHour: 4,
  running: 2, target: 3, ceiling: 5, queued: 7, held: false, heldReason: null, sourceAgeSec: 30, stale: false, ...patch,
});
const feed = (...lanes: FleetUsageLane[]): FleetUsageV1 => ({ schema: 'fleet-usage.v1', generatedAt: new Date(NOW).toISOString(), lanes });
const card = (name: string) => screen.findByRole('listitem', { name: `${name} lane` });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW); evictAll(); loader.load.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('LaneUsagePanel', () => {
  it('renders a normal lane with bar, countdown, slots and queue', async () => {
    loader.load.mockResolvedValue(feed(lane({})));
    render(<LaneUsagePanel />);
    const view = within(await card('claude'));
    expect(view.getByRole('meter', { name: 'claude used' })).toHaveAttribute('value', '40');
    expect(view.getByText('40% used')).toBeVisible();
    expect(view.getByText(/60% remaining/)).toBeVisible();
    expect(view.getByText(/^(10h 0m 00s|9h 59m \d\ds)$/)).toBeVisible();
    expect(view.getByLabelText('2 running, 3 target, 5 ceiling')).toBeVisible();
    expect(view.getByText('7')).toBeVisible();
    expect(view.getByText('20% unused at reset')).toBeVisible();
    expect(view.queryByText(/Held/)).toBeNull();
    expect(view.queryByText(/Stale source/)).toBeNull();
  });

  it('shows the held badge with its reason', async () => {
    loader.load.mockResolvedValue(feed(lane({ lane: 'devin', held: true, heldReason: 'ACU budget guard' })));
    render(<LaneUsagePanel />);
    const view = within(await card('devin'));
    expect(view.getByText('Held: ACU budget guard')).toBeVisible();
    expect(view.getByText(/60% unused at reset/)).toBeVisible();
  });

  it.each([['flag', { stale: true }], ['old reading', { sourceAgeSec: 7200 }]])('warns about a stale source (%s)', async (_n, patch) => {
    loader.load.mockResolvedValue(feed(lane({ lane: 'gemini', ...patch })));
    render(<LaneUsagePanel />);
    expect(within(await card('gemini')).getByText(/^Stale source:/)).toBeVisible();
  });

  it('shows unknown usage without implying spare capacity', async () => {
    loader.load.mockResolvedValue(feed(lane({ lane: 'omlx-local', window: 'none', usedPct: null, resetAt: null, burnPctPerHour: null, running: null, target: null, ceiling: null, queued: null })));
    render(<LaneUsagePanel />);
    const view = within(await card('omlx-local'));
    expect(view.getByText('Usage unknown')).toBeVisible();
    expect(view.getByRole('img', { name: 'omlx-local usage unknown' })).toBeVisible();
    expect(view.queryByRole('meter')).toBeNull();
    expect(view.getByText('Waste risk unknown')).toBeVisible();
    expect(view.getByText('Reset unknown')).toBeVisible();
    expect(view.getByLabelText('? running, ? target, ? ceiling')).toBeVisible();
    expect(view.queryByText(/remaining/)).toBeNull();
  });

  it('flags high waste and sorts the most at-risk lane first', async () => {
    loader.load.mockResolvedValue(feed(
      lane({ lane: 'zai', usedPct: 70, burnPctPerHour: 3 }),
      lane({ lane: 'unknown-lane', window: 'none', usedPct: null }),
      lane({ lane: 'codex-cmp', usedPct: 12, burnPctPerHour: 0.2 }),
      lane({ lane: 'claude', usedPct: 55, burnPctPerHour: 1 }),
    ));
    render(<LaneUsagePanel />);
    await card('zai');
    const order = within(screen.getByRole('list', { name: 'Lane usage cards' })).getAllByRole('listitem').map(item => item.getAttribute('aria-label'));
    expect(order).toEqual(['codex-cmp lane', 'claude lane', 'zai lane', 'unknown-lane lane']);
    const first = await card('codex-cmp');
    expect(first).toHaveAttribute('data-risk', 'high');
    expect(within(first).getByText(/High waste: 8\d(\.\d)?% unused at reset/)).toBeVisible();
  });

  it('polls every 15 seconds', async () => {
    loader.load.mockResolvedValue(feed(lane({})));
    render(<LaneUsagePanel />);
    await card('claude');
    const initial = loader.load.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(LANE_USAGE_POLL_MS + 1); });
    await waitFor(() => expect(loader.load.mock.calls.length).toBeGreaterThan(initial));
  });

  it('keeps the last reading but warns when a later poll fails', async () => {
    loader.load.mockResolvedValueOnce(feed(lane({}))).mockRejectedValue(new Error('down'));
    render(<LaneUsagePanel />);
    await card('claude');
    await act(async () => { vi.advanceTimersByTime(LANE_USAGE_POLL_MS + 1); });
    expect(await screen.findByRole('alert')).toHaveTextContent('not current');
    expect(screen.getByRole('listitem', { name: 'claude lane' })).toBeVisible();
  });

  it('shows an error with no reading yet', async () => {
    loader.load.mockRejectedValue(new Error('down'));
    render(<LaneUsagePanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No reading yet');
  });
});
