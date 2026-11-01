import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { LeaderJournalPane } from './LeaderJournalPane.js';

const host = { openPane: vi.fn() } as unknown as PaneProps['host'];
const props = { visible: true, host } as PaneProps;
const journal = {
  v: 1, generatedAt: '2026-01-01T12:30:00Z', notes: [],
  sources: { orchestration: 'healthy', planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
  passes: [{ at: '2026-01-01T12:00:00Z', sections: [] }, { at: '2026-01-01T12:10:00Z', sections: [] }],
  ingest: [], rejectedLastHour: 0,
  ingested: ['RQ-PHX-A', 'RQ-PHX-B', 'RQ-PHX-C', 'RQ-PHX-D'].map((id) => ({ at: '2026-01-01T12:11:00Z', id, leader: 'fake', lane: 'main', tier: 'mid', title: '' })),
};
const runs = {
  v: 1, generatedAt: journal.generatedAt,
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], leaders: [], orchestratorAgents: null, events: [], codexPersonal: null, inbox: [], drop: null,
  workers: [{ job: 'RQ-PHX-A', repo: 'fake', lane: 'main', tier: 'mid', ageSeconds: 20 }],
  publishesLastHour: [{ job: 'RQ-PHX-B', lane: 'main', url: null, at: journal.generatedAt }],
  mergesLastHour: { count: 1, items: [{ repo: 'fake', number: 2300, title: 'bridge: RQ-PHX-C (#2300)' }] },
};

beforeEach(() => { evictAll(); resetWorkerLogSelection(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); evictAll(); resetWorkerLogSelection(); });

it('renders pass fates and opens a job worker log', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('leader-journal') ? journal : runs)));
  render(<LeaderJournalPane {...props} />);
  expect(await screen.findByText('wrote 4 · running 1 · published 1 · merged 1 · waiting 1')).toBeInTheDocument();
  const passes = screen.getByRole('region', { name: 'Passes' });
  const details = passes.querySelectorAll('details');
  expect(within(details[1]!).getByText('wrote 0')).toBeInTheDocument();
  expect(within(details[1]!).queryByLabelText('Job fates')).not.toBeInTheDocument();
  expect(within(details[0]!).getByRole('button', { name: 'Open log for RQ-PHX-D (waiting)' })).toHaveAttribute('title', 'no trace in the last hour');
  fireEvent.click(within(details[0]!).getByRole('button', { name: 'Open log for RQ-PHX-A (running)' }));
  expect(takeRequestedWorkerLogJob()).toBe('RQ-PHX-A');
  expect(host.openPane).toHaveBeenCalledWith('worker-log');
});

it('shows unavailable runs without changing the journal', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('leader-journal') ? Response.json(journal) : Response.json({}, { status: 404 })));
  render(<LeaderJournalPane {...props} />);
  expect(await screen.findAllByText('fleet runs unavailable')).toHaveLength(2);
  expect(screen.getByRole('table', { name: 'Ingested jobs' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Job fates')).not.toBeInTheDocument();
});

it('polls fleet runs every 15 seconds only while visible', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:30:00Z'));
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes('leader-journal') ? journal : runs));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<LeaderJournalPane {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/fleet/runs'))).toHaveLength(2);
  view.rerender(<LeaderJournalPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/fleet/runs'))).toHaveLength(2);
});
