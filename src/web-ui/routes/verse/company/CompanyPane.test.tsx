import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { getPane } from '../panes/pane-registry.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { CompanyPane } from './CompanyPane.js';
import { at, lane, NOW, payloads, session, sessions } from './company.test-support.js';
import { hourOutcomes, lanePresence, recordedAt, usedFraction } from './company-model.js';
import './company.pane.js';

const openPane = vi.fn();
const props = { visible: true, host: { openPane } } as unknown as PaneProps;
const region = (name: string) => within(screen.getByRole('region', { name }));
function serve(data = payloads()) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const value = data[String(input)];
    return Response.json(value ?? {}, { status: value === undefined ? 503 : 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { cleanup(); evictAll(); resetWorkerLogSelection(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('composes existing GETs, observed channel identities, quota and muse; drills into jobs and PRs', async () => {
  const fetch = serve();
  render(<CompanyPane {...props} />);
  expect(await screen.findByText('Make Phantom useful')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('Loading Agent channel map…')).not.toBeInTheDocument());
  expect(region('Queue flow').getByText('6.0')).toBeInTheDocument();
  expect(region('Jobs').getByText('2')).toBeInTheDocument();
  expect(region('PR merge velocity').getByText('3')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'ashlrai/phantom#42' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/42');
  expect(region('Nodes & heartbeats').getByText('muse')).toBeInTheDocument();
  expect(screen.getByText('25.0% · used_frac 0.250')).toBeInTheDocument();
  expect(screen.getByText(at(-3600))).toBeInTheDocument();
  expect(region('Agent channel map').getByText('atlas')).toBeInTheDocument();
  expect(region('Agent bus').getByText('7')).toBeInTheDocument();
  expect(region('Agent bus').getByText('unknown')).toBeInTheDocument();
  fireEvent.click(region('Nodes & heartbeats').getByRole('button', { name: 'RQ-A' }));
  expect(takeRequestedWorkerLogJob()).toBe('RQ-A');
  expect(openPane).toHaveBeenCalledWith('worker-log');
  fireEvent.click(screen.getByRole('button', { name: 'PRs' }));
  expect(openPane).toHaveBeenCalledWith('fleet-merges');
  expect(fetch.mock.calls.filter(([url]) => url === '/api/fleet/sessions')).toHaveLength(1);
  expect(fetch.mock.calls).toHaveLength(9);
  for (const call of fetch.mock.calls) expect((call as unknown as [unknown, RequestInit])[1].method).toBe('GET');
  expect(getPane('company')?.needsSession).toBe(false);
});

it('isolates unavailable panels and retains clearly labelled stale readings after a failed refresh', async () => {
  const data = payloads();
  delete data['/api/nodes'];
  serve(data);
  render(<CompanyPane {...props} />);
  expect(await screen.findByText(/Nodes & heartbeats unavailable/)).toBeInTheDocument();
  expect(await screen.findByText('Make Phantom useful')).toBeInTheDocument();
  delete data['/api/verse/fleet/runs/mission'];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Leader line' }));
  expect(await screen.findByText(/Leader line unavailable.*last reading/)).toBeInTheDocument();
  expect(screen.getByText('Make Phantom useful')).toBeInTheDocument();
});

it('shows loading independently, then empty and missing measurements without invented success', async () => {
  const data = payloads();
  data['/api/fleet/sessions'] = { ...sessions, sourceState: 'missing', sessions: [], recent: [] };
  data['/api/fleet/lanes'] = { schema: 'fleet.lanes.v1', lanes: [], generatedAt: at(600) };
  data['/api/nodes'] = { schema: 'phantom.nodes.v1', nodes: [], error: null };
  data['/api/queue/stats?window=3600'] = { schemaVersion: 1, generatedAt: NOW, stations: [], pools: [] };
  data['/api/verse/fleet/work-board?limit=20'] = { inbox: 'ok', items: [], asOf: at() };
  data['/api/verse/fleet/comms-status'] = {};
  serve(data);
  render(<CompanyPane {...props} />);
  expect(screen.getByText('Loading Jobs…')).toBeInTheDocument();
  expect(await screen.findByText('No lanes recorded.')).toBeInTheDocument();
  expect(region('Jobs').getAllByText('unknown')).toHaveLength(3);
  expect(screen.getByText(/Muse heartbeat unknown/)).toBeInTheDocument();
  expect(screen.getByText(/No READY station observations/)).toBeInTheDocument();
  expect(screen.getByText(/No agent channel assignments/)).toBeInTheDocument();
  expect(screen.getByText(/Slack presence unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Stale · recorded 10m/)).toBeInTheDocument();
});

it('does no reads while hidden and stops polling when a visible pane is hidden', async () => {
  vi.useFakeTimers();
  const fetch = serve();
  const view = render(<CompanyPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(<CompanyPane {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetch).toHaveBeenCalledTimes(9);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetch).toHaveBeenCalledTimes(18);
  view.rerender(<CompanyPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetch).toHaveBeenCalledTimes(18);
});

it('bounds the last-hour window and labels truncation; missing and reset-pending evidence stays unknown', () => {
  const data = { ...sessions, truncated: true, recent: [...sessions.recent,
    session({ finishedAt: at(3600), outcome: 'failed' }), session({ finishedAt: at(-1), outcome: 'failed' })] };
  expect(hourOutcomes(data)).toEqual({ finished: 2, failed: 1, partial: true });
  expect(hourOutcomes({ ...data, sourceState: 'degraded' }).finished).toBeNull();
  expect(usedFraction({ ...lane, credit: { ...lane.credit, state: 'reset-pending' } })).toBeNull();
  expect(usedFraction({ ...lane, credit: { ...lane.credit, remainingPct: 101 } })).toBeNull();
  expect(lanePresence({ ...lane, liveJobs: null, hold: null })).toBe('unknown');
  expect(lanePresence({ ...lane, hold: { ...lane.hold!, held: true } })).toBe('blocked');
  expect(lanePresence({ ...lane, liveJobs: 0 })).toBe('idle');
  expect(recordedAt(at(-1), NOW)).toBe('Observation time unknown');
});

it('provides a retry for every failed source without suppressing the company shell', async () => {
  serve({});
  render(<CompanyPane {...props} />);
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(9));
  expect(screen.getByRole('heading', { name: 'One company. Shared progress.' })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^Refresh / })).toHaveLength(9);
});

it('marks bounded totals and keeps unsupported snapshots isolated', async () => {
  const data = payloads();
  data['/api/fleet/sessions'] = { ...sessions, truncated: true };
  data['/api/nodes'] = { schema: 'future.nodes.v2' };
  data['/api/fleet/lanes'] = {};
  serve(data);
  render(<CompanyPane {...props} />);
  expect(await screen.findByText('≥ 2')).toBeInTheDocument();
  expect(screen.getByText(/Node inventory unavailable: unsupported/)).toBeInTheDocument();
  expect(screen.getByText(/Lane roster unavailable: unsupported/)).toBeInTheDocument();
});

it('avoids reads when the document is hidden even with the Company tab selected', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const fetch = serve();
  render(<CompanyPane {...props} />);
  await act(async () => {});
  expect(fetch).not.toHaveBeenCalled();
});
