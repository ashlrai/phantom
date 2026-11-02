import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHostPane } from './FleetHostPane.js';
import { DropQueueCard } from './DropQueueCard.js';

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], claimed: [], leaders: [], orchestratorAgents: 0, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders drop files and a stuck verdict after planners', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/drop-jobs')
    ? Response.json({ v: 1, items: [{ id: 'FAKE01', lane: 'codex', tier: 'mid', title: 'Example task', bytes: 42, ageSeconds: 600 }] })
    : Response.json(runs)));
  render(<FleetHostPane visible />);
  const section = await screen.findByRole('region', { name: 'Drop queue' });
  expect(within(section).getByText('1 job waiting for ingest · oldest 10 min')).toHaveAttribute('data-tone', 'warn');
  expect(within(section).getByText('RQ-PHX-FAKE01 · codex/mid · Example task · 10 min')).toBeInTheDocument();
  expect(within(section).getByRole('status')).toHaveTextContent('Ingest looks stuck: the oldest file has waited 10 min. Check orch-ingest on this Mac.');
  expect(screen.getByRole('region', { name: 'Planners' }).compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('hides the card when the hub returns 404', async () => {
  const fetcher = vi.fn(async (url: string) => url.endsWith('/drop-jobs') ? Response.json({}, { status: 404 }) : Response.json(runs));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetHostPane visible />);
  await screen.findByRole('region', { name: 'Planners' });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/verse/fleet/live/drop-jobs', expect.anything()));
  expect(screen.queryByRole('region', { name: 'Drop queue' })).not.toBeInTheDocument();
});

it('polls every 30 seconds only while visible', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (_url: string) => Response.json({ v: 1, items: [] }));
  vi.stubGlobal('fetch', fetcher);
  const expectPolls = (count: number) => {
    for (const suffix of ['/drop-jobs', '/drop-fates']) {
      expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith(suffix))).toHaveLength(count);
    }
  };
  const view = render(<DropQueueCard visible />);
  await act(async () => {});
  expectPolls(1);
  await act(async () => { vi.advanceTimersByTime(29_999); });
  expectPolls(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  expectPolls(2);
  view.rerender(<DropQueueCard visible={false} />);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expectPolls(2);
  await act(async () => { view.rerender(<DropQueueCard visible />); });
  expectPolls(3);
});
