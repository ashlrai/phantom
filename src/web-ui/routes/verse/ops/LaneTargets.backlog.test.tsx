import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { LaneTargets } from './LaneTargets.js';
import { opsRunsQuery } from './ops-runs-queries.js';

const row = { lane: 'lane-a', target: 1, floor: 0, ceiling: 6, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const targetsBody = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [row] };
const runsBody = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'lane-a', running: 1, target: 1, queued: 139, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const token = 'a'.repeat(64);
beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

function stub(post: (body: unknown) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { post(JSON.parse(String(init.body))); return json({ ...targetsBody, lanes: [{ ...row, target: 6 }] }); }
    return json(url.endsWith('/fleet/runs') ? runsBody : targetsBody);
  }));
}

it('shows the running and waiting line and posts the suggested target once', async () => {
  setMutationToken(token);
  const post = vi.fn();
  stub(post);
  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true); // OpsRuns normally fills this shared cache
  render(<LaneTargets />);
  expect(await screen.findByText(/running 1 of 1 · 139 waiting/)).toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Raise to 6' });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ lane: 'lane-a', target: 6 });
});

it('disables the raise button without a mutation hold', async () => {
  stub(vi.fn());
  await refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true);
  render(<LaneTargets />);
  expect(await screen.findByRole('button', { name: 'Raise to 6' })).toBeDisabled();
});
