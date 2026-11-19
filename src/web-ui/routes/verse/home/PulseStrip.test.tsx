import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PulseLanesV1 } from '../../../../core/fleet/pulse-lanes.js';
import { PulseStrip, alertsOf, stripTiles } from './PulseStrip.js';

const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown }, alerts: { status: 'success', data: undefined as unknown } }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: (q: { key: string }) => q.key === 'fleet-pulse-alerts' ? state.alerts : state.read, useRefetch: () => vi.fn() }));

const hours = (f: (i: number) => number | null) => Array.from({ length: 24 }, (_, i) => f(i));
const BUSY: PulseLanesV1 = {
  schema: 'fleet.pulse.lanes.v1', v: 1, as_of: '2026-11-17T12:00:00.000Z', window_h: 24, headline: 'x', lanes: [],
  totals: { running: 3, capacity: 7, merged: 14, finished: 14, merged_per_h: 0.58, median_open_to_merge_s: 600, empty_rate: 0.214,
    series: { merged_per_h: Array.from({ length: 24 }, (_, i) => i % 5), median_open_to_merge_s: hours(i => i % 2 ? null : 600), empty_rate: hours(() => 0.2) } },
};
const UNREADABLE: PulseLanesV1 = { ...BUSY, totals: { running: null, capacity: null, merged: null, finished: null, merged_per_h: null, median_open_to_merge_s: null, empty_rate: null, series: { merged_per_h: [], median_open_to_merge_s: [], empty_rate: [] } } };
afterEach(() => { cleanup(); state.read = { status: 'success', data: undefined }; state.alerts = { status: 'success', data: undefined }; });
const tile = (name: string) => within(screen.getByRole('listitem', { name }));

describe('Pulse strip', () => {
  it('busy: four big numbers; three draw a 24 hour sparkline, running of capacity says it has no history', () => {
    state.read = { status: 'success', data: BUSY };
    render(<PulseStrip />);
    expect(screen.getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['Merged per hour', 'Minutes to merge', 'EMPTY', 'Running of capacity']);
    expect(tile('Merged per hour').getByText('0.58')).toBeTruthy();
    expect(tile('Minutes to merge').getByText('10 min')).toBeTruthy();
    expect(tile('EMPTY').getByText('21%')).toBeTruthy();
    expect(tile('Running of capacity').getByText('3 of 7')).toBeTruthy();
    expect(tile('Merged per hour').getByRole('img', { name: /^Merged per hour over 24 hours: 0, 1, 2/ })).toBeTruthy();
    expect(tile('Minutes to merge').getByRole('img', { name: /unknown/ })).toBeTruthy();
    expect(tile('Running of capacity').queryByRole('img')).toBeNull();
    expect(tile('Running of capacity').getByText('Now. No history is kept for this one.')).toBeTruthy();
  });

  it('unreadable metrics: unknown, never 0, and nothing is drawn', () => {
    expect(stripTiles(UNREADABLE).map(t => [t.value, t.known])).toEqual([['unknown', false], ['unknown', false], ['unknown', false], ['unknown', false]]);
    state.read = { status: 'success', data: UNREADABLE };
    render(<PulseStrip />);
    expect(screen.queryByText('0')).toBeNull();
    expect(tile('Merged per hour').getAllByText('unknown').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('idle: zeros are shown as zeros', () => {
    const idle = { ...BUSY, totals: { ...BUSY.totals, merged: 0, finished: 0, merged_per_h: 0, median_open_to_merge_s: null, empty_rate: null, series: { merged_per_h: hours(() => 0), median_open_to_merge_s: hours(() => null), empty_rate: hours(() => null) } } };
    state.read = { status: 'success', data: idle };
    render(<PulseStrip />);
    expect(tile('Merged per hour').getByText('0')).toBeTruthy();
    expect(tile('EMPTY').getByText('No job finished in this window.')).toBeTruthy();
  });

  it('stays hidden before the first read or for an older server, and says unknown on a failed read', () => {
    state.read = { status: 'success', data: { schema: 'something.else' } };
    expect(render(<PulseStrip />).container.innerHTML).toBe('');
    cleanup();
    state.read = { status: 'error', data: undefined };
    render(<PulseStrip />);
    expect(screen.getByText('Unknown: the throughput numbers could not be read.')).toBeTruthy();
  });
});

describe('Pulse alerts row', () => {
  const alerts = (list: unknown[], unknown: string[] = []) => ({ schema: 'fleet.pulse.alerts.v1', v: 1, as_of: '2026-11-17T12:00:00.000Z', alerts: list, unknown });
  const stalled = { kind: 'stalled', lane: 'fleet', since: '2026-11-17T11:00:00.000Z', detail: 'No job has started and no PR has merged for 60 minutes.', fix_hint: 'Check that the dispatcher is running.' };

  it('draws one red line per alert under the strip, with its fix', () => {
    state.read = { status: 'success', data: BUSY };
    state.alerts = { status: 'success', data: alerts([stalled]) };
    render(<PulseStrip />);
    const row = within(screen.getByRole('alert'));
    expect(row.getByText('No job has started and no PR has merged for 60 minutes.')).toBeTruthy();
    expect(row.getByText('Check that the dispatcher is running.')).toBeTruthy();
  });

  it('draws nothing for a quiet fleet or an unrelated payload, and says what could not be checked', () => {
    state.read = { status: 'success', data: BUSY };
    state.alerts = { status: 'success', data: alerts([]) };
    render(<PulseStrip />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(alertsOf({ schema: 'something.else' })).toBeNull();
    cleanup();
    state.alerts = { status: 'success', data: alerts([], ['Starved: the lane snapshot could not be read.']) };
    render(<PulseStrip />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Not checked: Starved: the lane snapshot could not be read\./)).toBeTruthy();
  });
});
