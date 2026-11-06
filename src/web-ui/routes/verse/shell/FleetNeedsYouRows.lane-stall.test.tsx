import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows, type FleetNeedsYouReport } from './FleetNeedsYouRows.js';

const NOW = Date.parse('2026-11-04T00:00:00Z');
const runs = {
  v: 1, generatedAt: new Date(NOW).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(NOW).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: null,
  lanes: [{ lane: 'fake-lane', running: 0, target: 4, queued: 13, held: false, heldReason: null, tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
  workers: [], claimed: [{ job: 'fake-job', lane: 'fake-lane', tier: 'fake', at: new Date(NOW - 20 * 60_000).toISOString() }],
  leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1, publishesLastHour: [],
  mergesLastHour: { count: 1, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => { localStorage.clear(); evictAll(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('renders the stalled lane row with its counts and opens Lanes, replacing the idle row', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/verse/fleet/runs'
    ? Response.json(runs) : new Response('', { status: 404 })));
  const reports: FleetNeedsYouReport[] = [];
  render(<FleetNeedsYouRows split="all" nowMs={NOW} onResult={report => reports.push(report)} />);
  expect(await screen.findByText('fake-lane stalled: 13 queued, 0 of 4 running, not held, no launch for 20 min')).toBeInTheDocument();
  await waitFor(() => expect(reports.at(-1)?.items.map(item => item.id)).toEqual(['lane-stall:fake-lane']));
  expect(screen.getByRole('button', { name: 'Open Lanes' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Lanes' }));
});
