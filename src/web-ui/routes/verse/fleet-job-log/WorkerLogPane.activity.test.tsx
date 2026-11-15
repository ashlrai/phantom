import { type MockInstance, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { loadMarkdownRenderer } from '../MessageMarkdown.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { WorkerLogPane } from './WorkerLogPane.js';

// The Markdown renderer is its own chunk; reports render through it here.
beforeAll(() => loadMarkdownRenderer());

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-ACT', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const detail = { schema: 'fleet.job.v1', job: 'RQ-ACT', state: 'running', lane: 'codex', tier: 'mid', model: 'm', log: { source: 'live', tail: ['npm test'], truncated: false } };
const activity = {
  schema: 'fleet.job.activity.v1', job: 'RQ-ACT', state: 'running', lane: 'codex', tier: 'mid', model: 'm',
  sources: { events: 'healthy', commands: 'healthy', files: 'missing', reports: 'healthy' },
  counts: { events: 1, commands: 1, files: 0, reports: 1 }, truncated: false,
  entries: [
    { kind: 'event', at: '2026-11-09T10:00:00+0000', event: 'launch', summary: 'lane=codex' },
    { kind: 'command', text: 'npm test -- --runInBand', line: 4 },
    { kind: 'files', state: 'missing', baseSha: null, files: [], totals: { files: 0, added: 0, removed: 0 }, truncated: false, refusals: [] },
    { kind: 'report', name: 'notes', state: 'ok', source: 'notes', bytes: 15, truncated: false, text: '## Summary\n\nShipped **the fix**.' },
    { kind: 'report', name: 'brief', state: 'missing', source: null, bytes: null, truncated: false, text: '' },
  ],
};
let spy: MockInstance<typeof client.apiGet>;
beforeEach(() => { evictAll(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); evictAll(); });

function serve(extra: Record<string, unknown> = {}) {
  spy = vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => {
    if (path === '/api/verse/fleet/runs') return fixture;
    if (path.startsWith('/api/fleet/job/activity')) return { ...activity, ...extra };
    if (path.startsWith('/api/fleet/job/changes')) return null;
    if (path.startsWith('/api/fleet/job/text')) return null;
    if (path.startsWith('/api/fleet/job?')) return detail;
    if (path.startsWith('/api/fleet/job/backlog')) return null;
    throw new client.ApiError('not found', 404, path);
  });
}

it('renders one searchable activity stream with commands, files state and inline reports', async () => {
  serve();
  render(<WorkerLogPane visible />);
  const section = await screen.findByRole('region', { name: 'Job activity' });
  // Waits for the activity fetch inside the section.
  expect(await within(section).findByText('launch')).toBeInTheDocument();
  expect(within(section).getByText('1 event · 1 command · 0 files · 1 report')).toBeInTheDocument();
  expect(within(section).getByText('npm test -- --runInBand')).toBeInTheDocument();
  expect(within(section).getByText(/log line 4/)).toBeInTheDocument();
  expect(within(section).getByText('No worktree on disk.')).toBeInTheDocument();
  expect(within(section).getByText('Brief: none on disk.')).toBeInTheDocument();
  // The report renders as markdown (heading + strong), not a raw pre.
  expect(within(section).getByText('Summary')).toBeInTheDocument();
  expect(within(section).getByText('the fix').tagName).toBe('STRONG');
});

it('filters the stream across commands, files and reports', async () => {
  serve();
  render(<WorkerLogPane visible />);
  const section = await screen.findByRole('region', { name: 'Job activity' });
  await within(section).findByText('launch');
  const filter = within(section).getByRole('searchbox', { name: 'Filter activity' });
  fireEvent.change(filter, { target: { value: 'npm test' } });
  expect(within(section).getByText('npm test -- --runInBand')).toBeInTheDocument();
  expect(within(section).queryByText('launch')).not.toBeInTheDocument();
  expect(within(section).getByText(/1 of 5 entries/)).toBeInTheDocument();
  fireEvent.change(filter, { target: { value: 'zzz-no-match' } });
  expect(within(section).getByText(/No activity entries match/)).toBeInTheDocument();
});

it('says when the activity API is absent and when a source is degraded', async () => {
  serve();
  spy.mockImplementation(async (path: string) => {
    if (path === '/api/verse/fleet/runs') return fixture;
    if (path.startsWith('/api/fleet/job/activity')) return { schema: 'fleet.job.activity.v1', sources: { commands: 'degraded' }, entries: [] };
    if (path.startsWith('/api/fleet/job')) throw new client.ApiError('missing', 404, path);
    throw new client.ApiError('not found', 404, path);
  });
  render(<WorkerLogPane visible />);
  const section = await screen.findByRole('region', { name: 'Job activity' });
  expect(await within(section).findByText(/Partial activity: commands/)).toBeInTheDocument();
});
