import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { WorkerLogPane } from './WorkerLogPane.js';
const runs = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-OTHER', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const changes = { schema: 'fleet.job.changes.v1', generatedAt: 'now', job: 'RQ-TEST', state: 'live', baseSha: 'a60908e', files: [{ path: 'src/file.ts', added: 41, removed: 3, status: 'modified' }, { path: 'new.ts', added: null, removed: null, status: 'untracked' }], totals: { files: 2, added: 41, removed: 3 }, truncated: false };
beforeEach(() => { evictAll(); vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); evictAll(); });
async function show(value: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const body = input.includes('/job/changes') ? value : input.includes('/job?') ? { schema: 'fleet.job.v1', state: 'running', log: { source: 'live', tail: ['working'] } } : runs;
    return new Response(JSON.stringify(body), { status: input.includes('/job/changes') ? status : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  render(<WorkerLogPane visible />); await act(async () => {});
}
it('renders changes totals, paths and untracked marks', async () => {
  await show(changes); expect(screen.getByRole('region', { name: 'Changes' })).toHaveTextContent('Changes · 2 files · +41 −3 · vs base a60908e');
  expect(screen.getByText('src/file.ts')).toBeInTheDocument(); expect(screen.getByText('untracked')).toBeInTheDocument();
});
it('renders the empty state', async () => { await show({ ...changes, files: [], totals: { files: 0, added: 0, removed: 0 } }); expect(screen.getByText('No changes yet')).toBeInTheDocument(); });
it('stays quiet on older servers', async () => { await show({}, 404); expect(screen.queryByRole('region', { name: 'Changes' })).not.toBeInTheDocument(); });

it('reports a missing worktree', async () => { await show({ ...changes, state: 'missing', files: [] }); expect(screen.getByText('Worktree not available')).toBeInTheDocument(); });
