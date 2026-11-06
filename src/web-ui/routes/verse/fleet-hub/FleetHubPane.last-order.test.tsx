import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getDockState, resetDockStore } from '../dock/dock-store.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHubPane } from './FleetHubPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:10:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [{ label: 'leader', ageSeconds: 300 }], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null,
  inbox: [{ at: '2026-10-31 08:08', source: 'Telegram', text: 'Check the fleet' }], drop: null,
};

beforeEach(() => { evictAll(); resetDockStore(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows the latest order, its acknowledgement and an inbox button', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-31T12:10:00Z'));
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/fleet/runs') ? Response.json(fixture) : new Response(null, { status: 404 })));
  render(<FleetHubPane visible />);
  const row = (await screen.findByText('Your last order')).parentElement!.parentElement!;
  expect(row).toHaveTextContent('Telegram · 2 minutes ago: Check the fleet');
  expect(within(row).getByText('Waiting · next pass in ~10 min')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'Open inbox' }));
  expect(getDockState().active).toBe('fleet-inbox');
});

it('omits the row for an empty inbox', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/fleet/runs') ? Response.json({ ...fixture, inbox: [] }) : new Response(null, { status: 404 })));
  render(<FleetHubPane visible />);
  await screen.findByText('0/0');
  expect(screen.queryByText('Your last order')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open inbox' })).not.toBeInTheDocument();
});
