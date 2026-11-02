import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll, runQuery } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { capacity, nativeSeat } from '../seat-fixtures.test-support.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { ResourcesBar } from './ResourcesBar.js';
import { RESOURCE_ORDER_KEY, reloadResourceOrderForTest } from './resource-order.js';
import { closeResources, reloadResourcesUiForTest, RESOURCES_STORAGE_KEY } from './resources-store.js';

vi.mock('../usage/CapacityStrip.js', async (original) => ({
  ...await original<typeof import('../usage/CapacityStrip.js')>(), useCapacityData: vi.fn(),
}));

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const fleetRuns: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T11:59:00.000Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: 60, diskFreeGb: 400, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex-personal', running: 0, target: 12, queued: 14, held: true,
    heldReason: 'usage limit until Nov 4 01:41', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], claimed: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
  mergesLastHour: { count: 0, items: [] }, events: [],
  codexPersonal: { usedPct: 87, resetsAt: '2026-11-04T12:00:00.000Z', asOf: '2026-10-31T11:57:00.000Z' },
  inbox: [], drop: null,
};

beforeEach(() => {
  evictAll(); localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest();
  localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
  vi.mocked(useCapacityData).mockReturnValue({ seats: [nativeSeat(capacity(), { id: 'codex-seat', engine: 'codex', label: 'Codex seat' })],
    health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
});
afterEach(() => {
  cleanup(); evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest();
  localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
});

function mount(snapshot: FleetRuns = fleetRuns) {
  installFetch(call => call.path === '/api/verse/fleet/runs' ? json(snapshot) : json({}));
  return render(<SectionVisibilityProvider visible><ResourcesBar expanded now={NOW} /></SectionVisibilityProvider>);
}

const personalRow = (container: HTMLElement) =>
  waitFor(() => {
    const row = container.querySelector('[data-resource-id="codex-personal:sessions"]') as HTMLElement;
    expect(row).toHaveTextContent('87% used'); return row;
  });

describe('codex-personal lane facts in the resources bar', () => {
  it('shows the held lane, its queue and its hold reason on the personal row tooltip', async () => {
    // Another surface already warmed the shared 'verse-fleet-runs' snapshot.
    await runQuery(opsRunsQuery.key, async () => fleetRuns);
    const view = mount();
    const row = await personalRow(view.container);
    fireEvent.focus(within(row).getByRole('button', { name: /Codex personal · session logs:/ }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Lane codex-personal: 0/12 running · 14 queued');
    expect(tip).toHaveTextContent('Held: usage limit (usage limit until Nov 4 01:41)');
  });

  it('shows only the lane line while the lane is unheld', async () => {
    await runQuery(opsRunsQuery.key, async () => ({ ...fleetRuns, lanes: [{ ...fleetRuns.lanes[0]!, held: false, heldReason: null }] }));
    const view = mount();
    const row = await personalRow(view.container);
    fireEvent.focus(within(row).getByRole('button', { name: /Codex personal · session logs:/ }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Lane codex-personal: 0/12 running · 14 queued');
    expect(tip).not.toHaveTextContent('Held:');
  });

  it('shows lane facts when the shared snapshot arrives and updates when the lane changes', async () => {
    const view = mount();
    const row = await personalRow(view.container);
    fireEvent.focus(within(row).getByRole('button', { name: /Codex personal · session logs:/ }));
    const tip = screen.getByRole('tooltip');
    expect(tip).not.toHaveTextContent('Lane codex-personal');
    await act(async () => runQuery(opsRunsQuery.key, async () => fleetRuns));
    await waitFor(() => expect(tip).toHaveTextContent('Lane codex-personal: 0/12 running · 14 queued'));
    expect(tip).toHaveTextContent('Held: usage limit');
    await act(async () => runQuery(opsRunsQuery.key, async () => ({
      ...fleetRuns, lanes: [{ ...fleetRuns.lanes[0]!, running: 3, queued: 2, held: false }],
    })));
    expect(tip).toHaveTextContent('Lane codex-personal: 3/12 running · 2 queued');
    expect(tip).not.toHaveTextContent('Held:');
  });

  it('leaves the detail empty when the snapshot has no lanes', async () => {
    await runQuery(opsRunsQuery.key, async () => ({ ...fleetRuns, lanes: [] }));
    const view = mount({ ...fleetRuns, lanes: [] });
    const row = await personalRow(view.container);
    fireEvent.focus(within(row).getByRole('button', { name: /Codex personal · session logs:/ }));
    const tip = screen.getByRole('tooltip');
    await waitFor(() => expect(tip).toHaveTextContent('Personal Codex weekly'));
    expect(tip).not.toHaveTextContent('Lane codex-personal');
    expect(tip).not.toHaveTextContent('Held:');
  });

  it('marks retained lane facts when a refresh fails', async () => {
    await runQuery(opsRunsQuery.key, async () => fleetRuns);
    const view = mount();
    const row = await personalRow(view.container);
    fireEvent.focus(within(row).getByRole('button', { name: /Codex personal · session logs:/ }));
    await act(async () => runQuery(opsRunsQuery.key, async () => { throw new Error('offline'); }));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Lane codex-personal: 0/12 running · 14 queued');
    expect(tip).toHaveTextContent('Held: usage limit');
    expect(tip).toHaveTextContent('Last known lane facts · latest refresh failed.');
  });
});
