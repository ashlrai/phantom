import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { WorkerLogPane } from './WorkerLogPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-NEW', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }, { job: 'RQ-OLD', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 720 }],
  claimed: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const base = { schema: 'fleet.job.v1', job: 'RQ-OLD', state: 'published', lane: 'codex-personal', tier: 'mid', model: 'model', log: { source: 'live', tail: ['first line', 'second line'], truncated: false } };
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { evictAll(); });
afterEach(() => { vi.restoreAllMocks(); evictAll(); });
function serve(publish: unknown) {
  spy = vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? fixture : { ...base, publish });
}
it('renders the worker TEST line, the owner-review note, and auto-merge off', async () => {
  serve({ prUrl: 'https://github.com/example/repo/pull/1', autoMerge: false, testLine: 'TEST vitest 12 passed', sensitive: ['src/cli/desktop.ts'] });
  render(<WorkerLogPane visible />);
  const publish = await screen.findByRole('region', { name: 'Publish' });
  const code = within(publish).getByText('TEST vitest 12 passed');
  expect(code.tagName).toBe('CODE');
  expect(publish).toHaveTextContent('Tests: TEST vitest 12 passed');
  const note = within(publish).getByRole('note');
  expect(note).toHaveTextContent('Touches owner-reviewed paths: src/cli/desktop.ts');
  expect(note).toHaveTextContent('needs an owner review before it can merge');
  expect(within(publish).getByText('Auto-merge: off')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'PR #1' })).toBeInTheDocument();
  expect(spy).toHaveBeenCalledWith('/api/fleet/job?id=RQ-OLD', undefined);
});
it('renders no publish facts when none apply', async () => {
  serve({ prUrl: 'https://github.com/example/repo/pull/1', autoMerge: true, testLine: null, sensitive: null });
  render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  expect(screen.getByRole('link', { name: 'PR #1' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Publish' })).not.toBeInTheDocument();
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  expect(screen.queryByText(/Tests:/)).not.toBeInTheDocument();
  expect(screen.queryByText('Auto-merge: off')).not.toBeInTheDocument();
});
it('renders nothing for an empty sensitive list', async () => {
  serve({ prUrl: 'https://github.com/example/repo/pull/1', autoMerge: true, testLine: null, sensitive: [] });
  render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  expect(screen.queryByRole('region', { name: 'Publish' })).not.toBeInTheDocument();
});
it('collapses whitespace and caps a long TEST line at 200 characters', async () => {
  serve({ prUrl: 'https://github.com/example/repo/pull/1', autoMerge: true, testLine: `${'a'.repeat(100)}   \n\t ${'b'.repeat(220)}`, sensitive: null });
  render(<WorkerLogPane visible />);
  const publish = await screen.findByRole('region', { name: 'Publish' });
  const code = within(publish).getByText(/^a+ b+…$/);
  expect(code.tagName).toBe('CODE');
  expect(code.textContent).toBe(`${'a'.repeat(100)} ${'b'.repeat(98)}…`);
  expect(code.textContent).toHaveLength(200);
});
it('caps owner-reviewed paths at five with a +N more tail', async () => {
  serve({ prUrl: 'https://github.com/example/repo/pull/1', autoMerge: true, testLine: null, sensitive: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'] });
  render(<WorkerLogPane visible />);
  const note = await screen.findByRole('note');
  expect(note).toHaveTextContent('Touches owner-reviewed paths: a.ts, b.ts, c.ts, d.ts, e.ts +2 more');
  expect(note).not.toHaveTextContent('f.ts');
  expect(screen.queryByText('Auto-merge: off')).not.toBeInTheDocument();
});
