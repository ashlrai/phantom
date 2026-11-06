/**
 * FleetNeedsYouRows.main-red-fix — the "Draft fix job" row action for
 * main-red-* items: it hands a complete fix-job draft to the queue pane's
 * New job sheet (seeded only when no unsent draft exists) and reveals the
 * fleet-queue pane. Nothing is sent — Write still needs the control unlock.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { openDropJobSheet } from '../fleet-queue/drop-job-sheet-store.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import type { MainHealthData } from './main-health-query.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

vi.mock('../dock/dock-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../dock/dock-store.js')>(),
  openDockPane: vi.fn(),
}));
vi.mock('../fleet-queue/drop-job-sheet-store.js', () => ({ openDropJobSheet: vi.fn(() => 'seeded') }));

const NOW = Date.parse('2026-10-31T12:00:00Z');
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

const fleet = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: 1, publishesLastHour: [],
  mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

const redRepo = { repo: 'phantom', branch: 'master', sha: SHA, state: 'red' as const,
  checkedAt: '2026-10-31T11:55:00Z', failingCheck: 'build', fixJobs: [], nightlyRed: null };

function mainHealth(over: Partial<MainHealthData> = {}): MainHealthData {
  return {
    v: 1, generatedAt: '2026-10-31T12:00:00Z', source: 'ok', statusAt: '2026-10-31T11:59:00Z',
    stale: false, guardianOff: false, red: 1, repos: [redRepo], ...over,
  };
}

function setup(health: MainHealthData, fleetOver: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/verse/fleet/runs') return Response.json({ ...fleet, ...fleetOver });
    if (path === '/api/verse/runs-history/main-health') return Response.json(health);
    return new Response('not found', { status: 404 });
  }));
  act(() => openVerseNeedsYou({ split: 'fleet' }));
  render(<FleetNeedsYouRows split="fleet" nowMs={NOW} onResult={() => {}} />);
}

beforeEach(() => { evictAll(); resetVerseUi(); sessionStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('Draft fix job seeds the sheet with a draft for the red repo and reveals the queue pane', async () => {
  const user = userEvent.setup();
  setup(mainHealth());
  await user.click(await screen.findByRole('button', { name: 'Draft fix job' }));
  expect(openDropJobSheet).toHaveBeenCalledOnce();
  const draft = vi.mocked(openDropJobSheet).mock.calls[0]![0];
  expect(draft).toMatchObject({ id: 'MAINFIXABCDEF0', lane: 'codex-personal', tier: 'mid' });
  expect(draft.body).toContain('phantom');
  expect(draft.body).toContain('build');
  expect(getVerseUiState().overlay).toBeNull();
  expect(openDockPane).toHaveBeenCalledWith('fleet-queue');
});

it('a kept draft stays in the drawer with an explanation instead of revealing the pane', async () => {
  vi.mocked(openDropJobSheet).mockReturnValue('kept');
  const user = userEvent.setup();
  setup(mainHealth());
  await user.click(await screen.findByRole('button', { name: 'Draft fix job' }));
  expect(await screen.findByText('You have an unsent draft; the fix draft was not applied.')).toBeInTheDocument();
  expect(getVerseUiState().overlay).toBe('needs-you');
  expect(openDockPane).not.toHaveBeenCalled();
});

it.each([
  ['guardian off', mainHealth({ repos: [], red: 0, guardianOff: true }), /The main guardian is switched off/],
  ['stale', mainHealth({ repos: [], red: 0, stale: true }), /The main guardian has not written since/],
])('has no button on the %s row', async (_name, health, title) => {
  setup(health);
  expect(await screen.findByText(title, {}, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Draft fix job' })).not.toBeInTheDocument();
});

it('has no button when the red repo already has a fix job', async () => {
  // claude-lane-down keeps the group mounted so "loaded" is observable.
  const claudeLane = { lane: 'claude', running: 0, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 };
  setup(mainHealth({ repos: [{ ...redRepo, fixJobs: ['RQ-PHX-EXISTING'] }] }), { claudeLane: 'down token rejected', lanes: [claudeLane] });
  expect(await screen.findByText(/Claude lane is down/, {}, { timeout: 3000 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Draft fix job' })).not.toBeInTheDocument();
});

it('keeps supporting repo red rows visible without a misrouted draft action', async () => {
  setup(mainHealth({ repos: [{ ...redRepo, repo: 'stack' }] }));
  expect(await screen.findByText(/stack master is red/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Draft fix job' })).not.toBeInTheDocument();
});
