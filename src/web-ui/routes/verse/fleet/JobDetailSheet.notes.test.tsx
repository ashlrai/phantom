import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { JobDetailSheet } from './JobDetailSheet.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const job = 'RQ-PHX-FOO';
const detail = { schema: 'fleet.job.v1', job, state: 'running', notes: { hasNotes: true }, lane: 'codex-personal',
  log: { source: 'live', tail: [] }, sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
const notes = { v: 1, job, kind: 'notes', state: 'ok', bytes: 80, truncated: false, text: 'Done.\nCloses #1500\nSee RQ-PHX-EXAMPLE31' };

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

it('shows closing issues and opens referenced worker logs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.startsWith('/api/fleet/job/text?') ? Response.json(notes) : Response.json(detail)));
  const onClose = vi.fn();
  render(<JobDetailSheet job={job} onClose={onClose} />);
  const section = await screen.findByRole('region', { name: 'Bridge notes' });
  expect(await within(section).findByText('Bridge notes · 3 lines')).toBeInTheDocument();
  const closes = within(section).getByText('Closes', { exact: false, selector: 'p' });
  const issue = within(closes).getByRole('link', { name: '#1500' });
  expect(issue).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/issues/1500');
  expect(issue).toHaveAttribute('target', '_blank');
  expect(issue).toHaveAttribute('rel', 'noopener noreferrer');
  fireEvent.click(within(section).getByRole('button', { name: 'Open log for RQ-PHX-EXAMPLE31' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-EXAMPLE31');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Notes present:/)).not.toBeInTheDocument();
});

it('reports a text route absent from an older build', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.startsWith('/api/fleet/job/text?') ? new Response(null, { status: 404 }) : Response.json(detail)));
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Notes not in this build')).toBeInTheDocument();
});

it('keeps unknown notes distinct when the older build has no notes fact', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.startsWith('/api/fleet/job/text?') ? new Response(null, { status: 404 }) : Response.json({ ...detail, notes: { hasNotes: null } })));
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Notes unknown in this build')).toBeInTheDocument();
});

it('polls notes only while the job is running and the sheet is visible', async () => {
  vi.useFakeTimers();
  let state = 'running';
  const fetcher = vi.fn(async (path: string) => path.startsWith('/api/fleet/job/text?') ? Response.json(notes) : Response.json({ ...detail, state }));
  vi.stubGlobal('fetch', fetcher);
  const sheet = (visible: boolean) => <SectionVisibilityProvider visible={visible}><JobDetailSheet job={job} onClose={vi.fn()} /></SectionVisibilityProvider>;
  const view = render(sheet(true));
  const calls = () => fetcher.mock.calls.filter(([path]) => path.startsWith('/api/fleet/job/text?')).length;
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(calls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(calls()).toBe(2);
  view.rerender(sheet(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(calls()).toBe(2);
  state = 'published';
  view.rerender(sheet(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const completedCalls = calls();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(calls()).toBe(completedCalls);
  view.unmount();
});
