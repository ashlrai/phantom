import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHostPane } from './FleetHostPane.js';

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex-personal', running: 0, target: 1, queued: 0, held: true, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [{ label: 'claude', ageSeconds: 600 }, { label: 'sol', ageSeconds: 4000 }], orchestratorAgents: 2,
  publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });
const serve = (data: FleetRuns) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));

it('renders planner rows and the personal lane explanation', async () => {
  serve(runs); render(<FleetHostPane visible />);
  const section = await screen.findByRole('region', { name: 'Planners' });
  expect(within(section).getByText('claude: 10:00 ago (ok)')).toHaveAttribute('data-tone', 'ok');
  expect(within(section).getByText('sol: 1:06 ago (bad)')).toHaveAttribute('data-tone', 'bad');
  expect(within(section).getByRole('status')).toHaveTextContent('The personal Codex lane is held; planner passes: sol (last pass: 1:06 ago).');
});

it('shows healthy rows without a tell and a message for no passes', async () => {
  serve({ ...runs, lanes: [], leaders: [{ label: 'fleet-leader', ageSeconds: 30 }] });
  const view = render(<FleetHostPane visible />);
  const section = await screen.findByRole('region', { name: 'Planners' });
  expect(within(section).getByText('fleet-leader: 00:30 ago (ok)')).toBeInTheDocument();
  expect(within(section).queryByRole('status')).not.toBeInTheDocument();
  view.unmount(); evictAll();
  serve({ ...runs, leaders: [] }); render(<FleetHostPane visible />);
  expect(await screen.findByText('No planner passes recorded')).toBeInTheDocument();
});
