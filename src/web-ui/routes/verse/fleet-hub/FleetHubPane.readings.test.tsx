import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { resetDockStore } from '../dock/dock-store.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHubPane } from './FleetHubPane.js';
import '../fleet-lanes/fleet-lanes.pane.js';
import '../fleet-events/fleet-events.pane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: new Date().toISOString(), sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: 12, diskFreeGb: 41.26, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: Array.from({ length: 13 }, (_, i) => ({ job: `job-${i}`, repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: i })),
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [{ repo: 'example/repo', number: 12, title: 'Fleet view' }, { repo: 'unknown', number: 13, title: 'No owner' }] }, events: [], codexPersonal: { usedPct: 93, resetsAt: null, asOf: null }, inbox: [], drop: null, claimed: [],
};

beforeEach(() => {
  localStorage.clear(); resetDockStore(); evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows how old the snapshot reading is above the tiles', async () => {
  render(<FleetHubPane visible />);
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('read just now');
});

it('fills live readings on the usage and host tiles', async () => {
  render(<FleetHubPane visible />);
  expect(await screen.findByText('93% personal')).toBeInTheDocument();
  expect(screen.getByText('41.3 GB free · 12% mem')).toBeInTheDocument();
});
