import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import * as recutClient from '../fleet-outcomes/recut-queue-client.js';
import { WorkerLogPane } from './WorkerLogPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.restoreAllMocks(); evictAll(); });

function setup(source: 'ok' | 'gh-failed', status = 'DIRTY') {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path.includes('fleet-backlog')
    ? { v: 1, repo: 'ashlrai/phantom', generatedAt: '2026-11-01', source, counts: { mergeState: {}, actions: {} }, items: [{ number: 2461, title: 'test', headRef: 'test', updatedAt: null, isDraft: false, job: null, mergeStateStatus: status, suggestedAction: status === 'DIRTY' ? 'recut' : 'refresh', classification: { class: 'conflicted', work: 'recut', reason: 'conflict' } }] }
    : path.includes('/job/changes') ? null : path.includes('/job?')
      ? { schema: 'fleet.job.v1', state: 'published', lane: 'codex', publish: { prUrl: 'https://github.com/ashlrai/phantom/pull/2461' } }
      : { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' }, lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [{ job: 'RQ-ONE', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null });
  render(<WorkerLogPane visible />);
}

it('queues a dirty PR once', async () => {
  const queue = vi.spyOn(recutClient, 'queueRecut').mockResolvedValue('queued');
  setup('ok');
  const button = await screen.findByRole('button', { name: 'Recut PR 2461' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText(/^Queued as RQ-PHX-/);
  expect(queue).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
}, 15000);

it('disables recut for a behind PR', async () => {
  setup('ok', 'BEHIND');
  expect(await screen.findByRole('button', { name: 'Recut PR 2461' })).toBeDisabled();
  expect(screen.getByText(/merge pass refreshes it/)).toBeInTheDocument();
});

it('reports an unavailable backlog without a button', async () => {
  setup('gh-failed');
  await screen.findByText('merge backlog unavailable');
  await waitFor(() => expect(screen.queryByRole('button', { name: /Recut PR/ })).not.toBeInTheDocument());
});
