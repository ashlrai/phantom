import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet, ApiError } from '../../../data/client.js';
import { JobDetailSheet } from './JobDetailSheet.js';

vi.mock('../../../data/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(),
}));

const job = 'RQ-PHX-FOO';
const detail = { schema: 'fleet.job.v1', job, state: 'running', lane: 'codex-personal',
  publish: { prUrl: 'https://github.com/example/repo/pull/12' }, log: { source: 'live', tail: ['Log line'] },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
const files = [
  { path: 'src/low.ts', status: 'modified', added: 1, removed: 0 },
  { path: 'src/high.ts', status: 'added', added: 8, removed: 1 },
  { path: 'src/mid.ts', status: 'deleted', added: 0, removed: 3 },
] as const;
const changes = { schema: 'fleet.job.changes.v1', generatedAt: '2026-10-30T23:38:00Z', job, state: 'live',
  baseSha: 'abcdef123456', files, totals: { files: 3, added: 9, removed: 4 }, truncated: false };

beforeEach(() => {
  evictAll();
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? changes : detail);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); evictAll(); });

it('shows sorted files and their headline alongside actions and the log', async () => {
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  const section = await screen.findByRole('region', { name: 'Changed files' });
  expect(await within(section).findByText('Changes · 3 files · +9 −4 · vs base abcdef1')).toBeInTheDocument();
  expect(within(section).getAllByRole('listitem').map(row => row.textContent)).toEqual(['A src/high.ts', 'D src/mid.ts', 'M src/low.ts']);
  expect(screen.getByRole('button', { name: 'Open worker log' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Steer this worker' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open PR #12' })).toBeInTheDocument();
  expect(screen.getByText('Log line')).toBeInTheDocument();
});

it('reports when the changes route is not in this build', async () => {
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path.startsWith('/api/fleet/job/changes?')) throw new ApiError('Not found', 404, path);
    return detail;
  });
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Changes are not in this build yet')).toBeInTheDocument();
});

it('distinguishes empty, missing, degraded, and failed changes', async () => {
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? { ...changes, files: [], state: 'live' } : detail);
  const view = render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('No changes yet')).toBeInTheDocument();
  view.unmount(); evictAll();
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? { ...changes, files: [], state: 'missing' } : detail);
  const missing = render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Worktree not available')).toBeInTheDocument();
  expect(screen.queryByText('No changes yet')).not.toBeInTheDocument();
  missing.unmount(); evictAll();
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? { ...changes, state: 'degraded', truncated: true } : detail);
  const degraded = render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Changes could not fully refresh.')).toBeInTheDocument();
  expect(screen.getByText('Showing a limited set of changes.')).toBeInTheDocument();
  degraded.unmount(); evictAll();
  vi.mocked(apiGet).mockImplementation(async path => { if (path.startsWith('/api/fleet/job/changes?')) throw new Error('offline'); return detail; });
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('Changes unavailable')).toBeInTheDocument();
});

it('limits the sorted list to 40 files', async () => {
  const many = Array.from({ length: 43 }, (_, i) => ({ path: `file-${String(i).padStart(2, '0')}`, status: 'untracked', added: i, removed: 0 }));
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? { ...changes, files: many } : detail);
  render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  expect(await screen.findByText('+3 more')).toBeInTheDocument();
  const rows = within(screen.getByRole('region', { name: 'Changed files' })).getAllByRole('listitem');
  expect(rows).toHaveLength(40);
  expect(rows[0]).toHaveTextContent('? file-42');
  expect(screen.queryByText('? file-00')).not.toBeInTheDocument();
});

it('polls changes while running and stops after completion or closing', async () => {
  vi.useFakeTimers();
  let state = 'running';
  vi.mocked(apiGet).mockImplementation(async path => path.startsWith('/api/fleet/job/changes?') ? changes : { ...detail, state });
  const view = render(<JobDetailSheet job={job} onClose={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const calls = () => vi.mocked(apiGet).mock.calls.filter(([path]) => path.startsWith('/api/fleet/job/changes?')).length;
  expect(calls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(calls()).toBe(2);
  state = 'published';
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  const completedCalls = calls();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(calls()).toBe(completedCalls);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(calls()).toBe(completedCalls);
});
