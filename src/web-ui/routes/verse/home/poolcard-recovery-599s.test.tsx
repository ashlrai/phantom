import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import { runway } from '../../../../core/usage/runway.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { resetWorkerLogSelection, takeRequestedWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { FLEET_RUNS_PATH, resetFleetRunsMissingForTest } from '../mobile/runs-queries.js';
import { HomePane } from './HomePane.js';

const dock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../dock/dock-store.js', async original => ({ ...await original<typeof import('../dock/dock-store.js')>(), openDockPane: dock.open }));
const home: HomeSummary = {
  schema: 'home.v1', asOf: '2026-11-18T12:00:00.000Z', health: 'healthy', headline: 'Fixture fleet healthy.',
  mergedLastHour: { state: 'ok', value: 2 }, merged24h: { state: 'ok', value: 5 }, medianMergeSeconds: { state: 'ok', value: 120 },
  main: { state: 'ok', value: [{ repo: 'demo', state: 'green' }] }, running: { state: 'ok', value: [{ lane: 'claude', running: 1, target: 2 }] },
  atRisk: { state: 'ok', value: null }, worklog: { state: 'ok', value: [] }, unreadLeaderReplies: { state: 'ok', value: 0 }, needsYou: { state: 'ok', value: [] },
};
const usage = { schema: 'pool.runway.v1', v: 1, asOf: home.asOf, headline: 'Fixture readings', pools: [
  runway({ pool: 'claude', usedPercent: 97, burnPerHour: 0.75, hoursToReset: 50 }),
] };
const runs = { v: 1, generatedAt: home.asOf, lastTick: null, paused: null, claudeLane: null, lanes: [], leaders: [], inbox: [], codexPersonal: null,
  mergesLastHour: { count: null, items: [] }, workers: [
    { job: 'fixture-build', repo: 'demo', lane: 'claude', tier: 'work', ageSeconds: 1 },
    { job: 'fixture-other', repo: 'demo', lane: 'grok', tier: 'work', ageSeconds: 1 },
  ] };
function show(reading: () => Response, jobs: () => Response = () => json(runs)) {
  const requests = installFetch(({ path }) => {
    if (path.startsWith(`${FLEET_RUNS_PATH}/home?`)) return json(home);
    if (path === '/api/usage/runway') return reading();
    if (path === FLEET_RUNS_PATH) return jobs();
    if (path === '/api/verse/shipped?since=24h') return json({ schema: 'fleet.shipped.v1', complete: true,
      totals: { merged: 5, mergedPerHour: 1, medianOpenToMergeSeconds: 120 }, items: [] });
    return json({});
  });
  render(<HomePane {...({ visible: true } as Parameters<typeof HomePane>[0])} />);
  return requests;
}
beforeEach(() => { evictAll(); resetFleetRunsMissingForTest(); resetWorkerLogSelection(); localStorage.clear(); });
afterEach(() => { cleanup(); evictAll(); resetWorkerLogSelection(); vi.unstubAllGlobals(); });

it('recovers measured pools alongside current Home content and lazily opens the existing worker log', async () => {
  const requests = show(() => json(usage));
  const pool = await screen.findByRole('button', { name: 'Claude: 3% left, runs out in about 4 h, resets in 50 h' });
  expect(pool).toHaveAttribute('data-warn', 'true');
  expect(await screen.findByText(home.headline)).toBeVisible();
  expect(screen.getByRole('region', { name: 'Merged PRs' })).toHaveTextContent('Last 24 hours: 5');
  expect(await screen.findByRole('region', { name: 'Shipped today' })).toHaveTextContent('5 merged');
  expect(requests.calls.filter(call => call.path === FLEET_RUNS_PATH)).toHaveLength(0);
  fireEvent.click(pool);
  const jobs = within(await screen.findByRole('region', { name: 'Claude running jobs' }));
  fireEvent.click(await jobs.findByRole('button', { name: 'fixture-build' }));
  expect(jobs.queryByText('fixture-other')).toBeNull();
  expect(takeRequestedWorkerLogJob()).toBe('fixture-build');
  expect(dock.open).toHaveBeenLastCalledWith('worker-log');
  expect(requests.calls.filter(call => call.path === FLEET_RUNS_PATH)).toHaveLength(1);
  expect(requests.calls.every(call => call.method === 'GET')).toBe(true);
});
it.each(['failed', 'malformed', 'missing pool'] as const)('keeps %s usage unknown while workers remain accessible', async kind => {
  const requests = show(() => kind === 'failed' ? json({}, 503) : kind === 'malformed' ? json({}) : json({ ...usage, pools: [] }));
  await screen.findByText(home.headline);
  if (kind !== 'missing pool') expect(await screen.findByText(/Pool readings unavailable/)).toBeVisible();
  const pool = screen.getByRole('button', { name: 'Claude: usage unknown, runway unknown, reset unknown' });
  expect(pool).not.toHaveAttribute('data-warn');
  expect(screen.getByRole('button', { name: 'Local: free, limited by memory' })).toBeVisible();
  expect(requests.calls.filter(call => call.path === FLEET_RUNS_PATH)).toHaveLength(0);
  fireEvent.click(pool);
  expect(await screen.findByRole('button', { name: 'fixture-build' })).toBeVisible();
  expect(screen.queryByText('No running jobs.')).toBeNull();
  expect(screen.queryByText(/Claude: 100% left|Claude: 0% left|nothing using it/)).toBeNull();
});
it.each(['failed', 'missing workers'] as const)('keeps %s job reads unknown, never an empty measured list', async kind => {
  show(() => json(usage), () => kind === 'failed' ? json({}, 503) : json({ ...runs, workers: undefined }));
  fireEvent.click(await screen.findByRole('button', { name: /^Claude: 3% left/ }));
  expect(await screen.findByText('Running jobs unknown.')).toBeVisible();
  expect(screen.queryByText('No running jobs.')).toBeNull();
});
