import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows, type FleetNeedsYouReport } from './FleetNeedsYouRows.js';
import { CLAUDE_LANE_FIX_COMMAND } from './claude-lane-needs-you.js';

const now = new Date(2026, 10, 1, 4, 31, 50).getTime();
const fleet = {
  v: 1, generatedAt: new Date(now).toISOString(), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(now).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: 'down token rejected 2026-11-01 01:31:50',
  lanes: [{ lane: 'claude', running: 0, target: 12, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [{ label: 'fake-leader', ageSeconds: 0 }], orchestratorAgents: 1, publishesLastHour: [], mergesLastHour: { count: 1, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
beforeEach(() => evictAll());
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('reports the lane in the drawer and copies its fix without closing the row', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/verse/fleet/runs'
    ? Response.json(fleet) : new Response('', { status: 404 })));
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const reports: FleetNeedsYouReport[] = [];
  render(<FleetNeedsYouRows split="fleet" nowMs={now} onResult={report => reports.push(report)} />);
  expect(await screen.findByText('Claude lane is down: 12 slots idle')).toBeVisible();
  expect(screen.getByText(/token rejected · since 01:31/)).toHaveTextContent('every hour idle is 12 worker-hours unused');
  expect(screen.getByText(CLAUDE_LANE_FIX_COMMAND)).toBeVisible();
  await waitFor(() => expect(reports.at(-1)?.items.some(item => item.id === 'claude-lane-down')).toBe(true));
  await user.click(screen.getByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith(CLAUDE_LANE_FIX_COMMAND);
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
});
